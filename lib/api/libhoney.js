/* eslint-env node */
const libhoney = require("libhoney").default,
  os = require("os"),
  process = require("process"),
  path = require("path"),
  uuidv4 = require("uuid/v4"),
  tracker = require("../async_tracker"),
  instrumentation = require("../instrumentation"),
  DeterministicSampler = require("../deterministic_sampler"),
  schema = require("../schema"),
  pkg = require(path.join(__dirname, "..", "..", "package.json")),
  debug = require("debug")(`${pkg.name}:event`);

const defaultName = "nodejs";

const incr = (payload, key, val = 1) => {
  payload[key] = (payload[key] || 0) + val;
};

module.exports = class LibhoneyEventAPI {
  constructor(opts) {
    let sampleRate;
    let optsWithoutSampleRate = {};
    Object.keys(opts).forEach(k => {
      if (k === "sampleRate") {
        sampleRate = opts[k];
      } else {
        optsWithoutSampleRate[k] = opts[k];
      }
    });
    if (typeof sampleRate === "number") {
      this.ds = new DeterministicSampler(sampleRate);
    } else if (typeof sampleRate !== "undefined") {
      debug(".sampleRate must be a number.  ignoring.");
    }

    this.honey = new libhoney(
      Object.assign(
        {
          apiHost: process.env["HONEYCOMB_API_HOST"] || "https://api.honeycomb.io",
          writeKey: process.env["HONEYCOMB_WRITEKEY"],
          dataset: process.env["HONEYCOMB_DATASET"] || defaultName,
          userAgentAddition: `honeycomb-beeline/${pkg.version}`,
        },
        optsWithoutSampleRate
      )
    );
    this.honey.add({
      [schema.HOSTNAME]: os.hostname(),
      [schema.TRACE_SERVICE_NAME]: opts.serviceName,
    });
  }

  startTrace(metadataContext, traceId, parentSpanId) {
    const id = traceId || uuidv4();

    if (this.ds && !this.ds.sample(id)) {
      // don't create the context at all if this request isn't going to send a trace
      return null;
    }

    tracker.setTracked({
      id,
      customContext: {},
      stack: [],
    });
    return this.startSpan(metadataContext, id, parentSpanId);
  }

  finishTrace(ev) {
    this.finishSpan(ev);
    tracker.deleteTracked();
  }

  startSpan(
    metadataContext,
    spanId = uuidv4(),
    parentId = metadataContext[schema.TRACE_PARENT_ID]
  ) {
    let context = tracker.getTracked();
    if (context.stack.length > 0 && !parentId) {
      parentId = context.stack[context.stack.length - 1][schema.TRACE_SPAN_ID];
    }
    const eventPayload = Object.assign({}, metadataContext, {
      [schema.TRACE_ID]: context.id,
      [schema.TRACE_SPAN_ID]: spanId,
      startTime: Date.now(),
      startTimeHR: process.hrtime(),
    });
    if (parentId) {
      eventPayload[schema.TRACE_PARENT_ID] = parentId;
    }
    context.stack.push(eventPayload);
    return eventPayload;
  }

  hrTimeToMS(hrTime) {
    return (hrTime[0] * 1e9 + hrTime[1]) / 1e6;
  }

  finishSpan(payload, rollup) {
    const context = tracker.getTracked();
    if (!context) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      this.askForIssue("no context in finishSpan.");
      return;
    }
    if (context.stack.length === 0) {
      // this _really_ shouldn't happen.
      this.askForIssue("no payload for event we're trying to finish (stack is empty).");
      return;
    }
    const idx = context.stack.indexOf(payload);
    if (idx === -1) {
      // again, this _really_ shouldn't happen.
      this.askForIssue(
        "no payload for event we're trying to finish (event not found)."
      );
      return;
    }
    if (idx !== context.stack.length - 1) {
      // the event we're finishing isn't the most deeply nested one. warn the user.
      this.askForIssue(
        "finishing an event with unfinished nested events. almost certainly not what we want."
      );
    }

    const { startTime, startTimeHR } = payload;
    const duration = process.hrtime(startTimeHR);
    const durationMs = this.hrTimeToMS(duration);

    payload[schema.DURATION_MS] =
      payload[schema.DURATION_MS] != null ? payload[schema.DURATION_MS] : durationMs;
    payload.endTimeHR = payload.endTimeHR || process.hrtime();

    // chop off events after (and including) this one from the stack.
    context.stack = context.stack.slice(0, idx);

    tracker.runWithoutTracking(() => {
      if (rollup) {
        // verify that the stack is not empty.  if it is, we're trying to rollup from a request event
        if (context.stack.length === 0) {
          debug("no event to rollup into");
        } else {
          const rootPayload = context.stack[0];
          const type = payload[schema.EVENT_TYPE];

          // per-rollup rollups
          incr(rootPayload, `totals.${type}.${rollup}.count`);
          incr(rootPayload, `totals.${type}.${rollup}.duration_ms`, durationMs);

          // per-instrumentation rollups
          incr(rootPayload, `totals.${type}.count`);
          incr(rootPayload, `totals.${type}.duration_ms`, durationMs);
        }
      }

      const active_instrumentations = instrumentation.activeInstrumentations();
      const active_instrumentation_count = active_instrumentations.length;
      const ev = this.honey.newEvent();
      ev.timestamp = new Date(startTime);
      ev.add(payload);
      ev.add(context.customContext);
      ev.add({
        [schema.INSTRUMENTATIONS]: active_instrumentations,
        [schema.INSTRUMENTATION_COUNT]: active_instrumentation_count,
        [schema.BEELINE_VERSION]: pkg.version,
        [schema.NODE_VERSION]: process.version,
      });
      ev.send();
    });
  }

  addContext(map) {
    const context = tracker.getTracked();
    if (!context) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      return;
    }
    Object.assign(context.customContext, map);
  }

  removeContext(key) {
    const context = tracker.getTracked();
    if (!context) {
      // valid, since we can end up in our instrumentation outside of requests we're tracking
      return;
    }
    delete context.customContext[key];
  }

  dumpRequestContext() {
    const context = tracker.getTracked();
    if (!context) {
      return "";
    }
    return ["current request context:"]
      .concat(context.stack.map((payload, idx) => `${idx}: ${JSON.stringify(payload)}`))
      .join("\n");
  }

  askForIssue(msg, logger = debug) {
    logger(`-------------------
    ${pkg.name} error: ${msg}
    please paste this message (everything between the "----" lines) into an issue
    at ${pkg.bugs.url}.  feel free to edit
    out any application stack frames if you'd rather not share those
    ${new Error().stack}
    ${this.dumpRequestContext()}
    -------------------`);
  }
};
