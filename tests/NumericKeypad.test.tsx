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

  it("入場番号では先頭の0を保持できる", () => {
    const onChange = vi.fn();
    render(
      <NumericKeypad
        value="0"
        onChange={onChange}
        onConfirm={() => undefined}
        confirmLabel="番号を一覧へ追加"
        preserveLeadingZeros
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(onChange).toHaveBeenCalledWith("01");
  });
});
