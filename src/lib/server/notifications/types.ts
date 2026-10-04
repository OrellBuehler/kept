export interface NotificationMessage {
  title: string;
  body: string;
}

export interface NotificationEvent extends NotificationMessage {
  /** Stable per event, e.g. `bill-overdue:<billId>:<dueDate>`; used to notify once. */
  key: string;
}

/** A channel adapter: delivers one message or throws a `ChannelError`. */
export interface Channel {
  send(message: NotificationMessage): Promise<void>;
}

/** `reason` is short and never contains message content; it is stored and shown in the UI. */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(code);
    this.name = "ChannelError";
  }
}

export interface TriggerSettings {
  billDueEnabled: boolean;
  billDueDays: number;
  billOverdueEnabled: boolean;
  budgetEnabled: boolean;
  budgetPercent: number;
  staleImportEnabled: boolean;
  staleImportDays: number;
}

export const DEFAULT_SETTINGS: TriggerSettings = {
  billDueEnabled: false,
  billDueDays: 3,
  billOverdueEnabled: false,
  budgetEnabled: false,
  budgetPercent: 100,
  staleImportEnabled: false,
  staleImportDays: 14,
};
