import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumericKeypad } from "../src/client/components/NumericKeypad";

describe("NumericKeypad", () => {
  it("端末inputを使わず数字と決定操作を提供する", () => {
    const onChange = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(
      <NumericKeypad value="" onChange={onChange} onConfirm={onConfirm} confirmLabel="人数を追加" />,
    );
    expect(container.querySelector("input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    expect(onChange).toHaveBeenCalledWith("7");
  });

  it("空欄時は決定を無効にする", () => {
    render(<NumericKeypad value="" onChange={() => undefined} onConfirm={() => undefined} confirmLabel="検索" />);
    expect(screen.getByRole("button", { name: "検索" })).toBeDisabled();
  });

  it("確定不可でも数字入力とちょうどボタンは使える", () => {
    render(
      <NumericKeypad
        value=""
        onChange={() => undefined}
        onConfirm={() => undefined}
        confirmLabel="会計確定・発番"
        confirmDisabled
        quickExactValue={300}
      />,
    );
    expect(screen.getByRole("button", { name: "1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "ちょうど 300円" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "会計確定・発番" })).toBeDisabled();
  });
});
