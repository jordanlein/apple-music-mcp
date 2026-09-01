export const DEFAULT_HISTORY_TIME_ZONE = "America/Denver";

export const timeframePresetValues = [
  "today",
  "24h",
  "7d",
  "30d",
  "90d",
  "ytd",
  "last_year",
  "all_time"
] as const;

export type TimeframePreset = (typeof timeframePresetValues)[number];

export interface TimeframeOptions {
  preset?: TimeframePreset;
  start?: string;
  end?: string;
  timeZone?: string;
}

export interface ResolvedTimeframe {
  mode: "preset" | "custom";
  preset?: TimeframePreset;
  startIso?: string;
  endIso: string;
  label: string;
  timeZone: string;
}

export function resolveTimeframe(
  options: TimeframeOptions = {},
  now = new Date()
): ResolvedTimeframe {
  if (!Number.isFinite(now.getTime())) throw new Error("The current time is invalid.");
  const timeZone = validateTimeZone(options.timeZone ?? DEFAULT_HISTORY_TIME_ZONE);
  const hasPreset = options.preset !== undefined;
  const hasCustom = options.start !== undefined || options.end !== undefined;
  if (hasPreset && hasCustom) {
    throw new Error("Choose either a preset or a custom start/end range, not both.");
  }
  if (options.end !== undefined && options.start === undefined) {
    throw new Error("A custom end requires a custom start.");
  }

  if (options.start !== undefined) {
    const startIso = parseBoundedIso(options.start, "start");
    const endIso = options.end === undefined ? now.toISOString() : parseBoundedIso(options.end, "end");
    if (Date.parse(startIso) >= Date.parse(endIso)) {
      throw new Error("The custom start must be earlier than the custom end.");
    }
    if (Date.parse(endIso) > now.getTime()) {
      throw new Error("The custom end cannot be in the future.");
    }
    return {
      mode: "custom",
      startIso,
      endIso,
      label: `${startIso} through ${endIso}`,
      timeZone
    };
  }

  const preset = options.preset ?? "7d";
  const endIso = now.toISOString();
  if (preset === "all_time") {
    return { mode: "preset", preset, endIso, label: "All observed history", timeZone };
  }

  let start: Date;
  let end = now;
  if (preset === "today") {
    const parts = zonedDateParts(now, timeZone);
    start = zonedDateTimeToUtc(parts.year, parts.month, parts.day, timeZone);
  } else if (preset === "24h") {
    start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  } else if (preset === "7d") {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (preset === "30d") {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (preset === "90d") {
    start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else {
    const currentYear = zonedDateParts(now, timeZone).year;
    if (preset === "ytd") {
      start = zonedDateTimeToUtc(currentYear, 1, 1, timeZone);
    } else {
      start = zonedDateTimeToUtc(currentYear - 1, 1, 1, timeZone);
      end = zonedDateTimeToUtc(currentYear, 1, 1, timeZone);
    }
  }

  return {
    mode: "preset",
    preset,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label: presetLabel(preset, zonedDateParts(now, timeZone).year),
    timeZone
  };
}

function parseBoundedIso(value: string, field: "start" | "end"): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`The custom ${field} must be an ISO 8601 timestamp with Z or a UTC offset.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`The custom ${field} timestamp is invalid.`);
  return parsed.toISOString();
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new Error(`Invalid IANA time zone: ${value}`);
  }
}

function presetLabel(preset: Exclude<TimeframePreset, "all_time">, currentYear: number): string {
  if (preset === "today") return "Today";
  if (preset === "24h") return "Last 24 hours";
  if (preset === "7d") return "Last 7 days";
  if (preset === "30d") return "Last 30 days";
  if (preset === "90d") return "Last 90 days";
  if (preset === "ytd") return `${currentYear} so far`;
  return `${currentYear - 1}`;
}

function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function zonedDateTimeToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desiredAsUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const representedAsUtc = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second")
    );
    const adjustment = desiredAsUtc - representedAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}
