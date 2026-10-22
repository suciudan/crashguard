import * as Sentry from "@sentry/node";

const dsn = process.argv[2] || process.env.SENTRY_DSN;
if (!dsn) {
  console.error("Usage: npm run example:error -- '<DSN from SDK setup>'");
  process.exitCode = 1;
} else {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    // Report a useful setup error without echoing the supplied DSN.
  }
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    !url.username ||
    !/^\/\d+$/.test(url.pathname)
  ) {
    console.error(
      "Copy the complete http(s) DSN from your project's SDK setup.",
    );
    process.exitCode = 1;
  } else {
    let accepted = false;
    Sentry.init({
      dsn,
      environment: "first-run",
      release: "crashguard-node-example@1.0.0",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      transport: (options) => {
        const transport = Sentry.makeNodeTransport(options);
        return {
          ...transport,
          async send(envelope) {
            const response = await transport.send(envelope);
            // flush() alone can succeed even when ingestion rejects the event.
            if (envelope[1].some(([header]) => header.type === "event")) {
              accepted =
                response.statusCode >= 200 && response.statusCode < 300;
            }
            return response;
          },
        };
      },
    });
    Sentry.setTag("example", "node");
    Sentry.addBreadcrumb({
      category: "example",
      message: "Sending the first exception",
    });
    const eventId = Sentry.captureException(new Error("Hello from CrashGuard"));
    const flushed = await Sentry.close(10000);
    if (!flushed || !accepted) {
      console.error(
        "The event was not accepted. Check the DSN, server logs, and network access.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Captured event ${eventId}. Open Issues → Hello from CrashGuard.`,
      );
    }
  }
}
