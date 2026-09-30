/** Client-safe constants shared by the import UI and the server modules. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const DELIMITERS = ["auto", ",", ";", "\t", "|"] as const;
export const ENCODINGS = [
  "auto",
  "utf-8",
  "utf-16le",
  "windows-1252",
  "iso-8859-1",
] as const;
export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "DD.MM.YYYY",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD.MM.YY",
  "YYYYMMDD",
] as const;
