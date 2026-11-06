/**
 * The copy buttons markdown.ts puts on code blocks: rendered Markdown is plain HTML, so one delegated
 * click handler serves them all. Returns whether the click was on one.
 */
export function copyCode(event: React.MouseEvent): boolean {
  const button = (event.target as HTMLElement).closest(".copy");
  if (!button) return false;
  const code = button.closest(".code")?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    const label = button.querySelector("span");
    if (!label) return;
    label.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      label.textContent = "Copy";
      button.classList.remove("copied");
    }, 1200);
  });
  return true;
}
