import type { MutationAction, MutationPayload } from "../shared/api";

export type Mutate = <T>(action: MutationAction, payload: MutationPayload, successMessage?: string) => Promise<T | null>;

export type RequestConfirmation = (
  title: string,
  description: string,
  action: () => void | Promise<void>,
) => void;

export type ScreenName = "home" | "sales" | "admission" | "records" | "accounting" | "admin";
