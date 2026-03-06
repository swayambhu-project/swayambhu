// Dashboard operator config — edit these values to customize the dashboard.
window.DASHBOARD_CONFIG = {
  // Timezone for all displayed timestamps (IANA format).
  // Examples: "Asia/Kolkata", "America/New_York", "UTC"
  timezone: "Asia/Kolkata",

  // Locale for date/time formatting.
  // Examples: "en-IN", "en-US", "en-GB"
  locale: "en-IN",

  // Max characters shown before "show more" truncation.
  truncate: {
    jsonString: 800,   // inside JSON viewer (nested string values)
    textBlock: 800,    // standalone text blocks (detail panel, reflections)
  },

  // Live watch polling interval (ms) when watching a session.
  watchIntervalMs: 2000,
};
