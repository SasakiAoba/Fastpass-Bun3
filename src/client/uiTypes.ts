import type { FastpassData } from "../domain/types";

export type Commit = <T>(recipe: (draft: FastpassData) => T, successMessage?: string) => T | null;

export type RequestConfirmation = (
  title: string,
  description: string,
  action: () => void,
) => void;

export type ScreenName = "home" | "sales" | "admission" | "records" | "accounting" | "admin";
