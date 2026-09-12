export type DayNumber = 1 | 2 | 3;

export type FastpassConfig = {
  TICKET_PREFIX: string;
  UNIT_PRICE_YEN: number;
  MAX_TICKET_NUMBER: number;
  DAILY_TICKET_LIMITS: Record<DayNumber, number>;
  EVENT_DATES: Record<DayNumber, string | null>;
  MIN_TICKET_NUMBER: number;
  NUMBER_MIN_DIGITS: number;
  TIME_ZONE: "Asia/Tokyo";
  CHECKOUT_HOLD_SECONDS: number;
  MAX_ITEMS_PER_OPERATION: number;
  MAX_TENDERED_YEN: number;
  POLLING_INTERVAL_MS: number;
  ALLOW_DEVELOPER_MODE: boolean;
};

export const FASTPASS_CONFIG = {
  TICKET_PREFIX: "HC-",
  UNIT_PRICE_YEN: 100,
  MAX_TICKET_NUMBER: 200,
  DAILY_TICKET_LIMITS: {
    1: 200,
    2: 200,
    3: 200,
  },
  EVENT_DATES: {
    1: null,
    2: null,
    3: null,
  },
  MIN_TICKET_NUMBER: 1,
  NUMBER_MIN_DIGITS: 3,
  TIME_ZONE: "Asia/Tokyo",
  CHECKOUT_HOLD_SECONDS: 180,
  MAX_ITEMS_PER_OPERATION: 200,
  MAX_TENDERED_YEN: 100_000,
  POLLING_INTERVAL_MS: 5_000,
  ALLOW_DEVELOPER_MODE: true,
} as const satisfies FastpassConfig;

export function validateConfig(config: FastpassConfig): string[] {
  const errors: string[] = [];
  if (!/^[A-Z]{2}-$/.test(config.TICKET_PREFIX)) {
    errors.push("表示接頭辞は大文字英字2文字とハイフンにしてください。");
  }
  if (!Number.isSafeInteger(config.UNIT_PRICE_YEN) || config.UNIT_PRICE_YEN < 1) {
    errors.push("単価は1円以上の整数にしてください。");
  }
  if (!Number.isSafeInteger(config.MAX_TICKET_NUMBER) || config.MAX_TICKET_NUMBER < 1) {
    errors.push("最大番号は1以上の整数にしてください。");
  }
  if (config.MIN_TICKET_NUMBER !== 1) {
    errors.push("初版の最小番号は1です。");
  }
  if (config.NUMBER_MIN_DIGITS !== 3) {
    errors.push("初版の最小表示桁数は3です。");
  }
  for (const day of [1, 2, 3] as const) {
    const limit = config.DAILY_TICKET_LIMITS[day];
    if (!Number.isSafeInteger(limit) || limit < 0) {
      errors.push(`${day}日目の上限は0以上の整数にしてください。`);
    }
  }
  const configuredDates = ([1, 2, 3] as const)
    .map((day) => config.EVENT_DATES[day])
    .filter((date): date is string => date !== null);
  if (new Set(configuredDates).size !== configuredDates.length) {
    errors.push("開催日は重複させないでください。");
  }
  for (const date of configuredDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+09:00`))) {
      errors.push(`開催日 ${date} は有効なYYYY-MM-DDではありません。`);
    }
  }
  if (configuredDates.length === 3 && [...configuredDates].sort().join() !== configuredDates.join()) {
    errors.push("開催日は1日目から3日目の順にしてください。");
  }
  return errors;
}
