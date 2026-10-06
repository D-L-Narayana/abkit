import { expect, test } from "./fixtures";
import { navigateTo, open } from "./helpers";

const activeElement = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const main = document.getElementById("main");
    return { tag: el?.tagName.toLowerCase() ?? "", id: el?.id ?? "", text: el?.textContent?.trim().slice(0, 40) ?? "", inMain: Boolean(el && main && main.contains(el)), isMain: el === main };
  });

test.describe("app shell accessibility", () => {
  test("the skip link is the first tab stop and moves focus to the main landmark", async ({ page }) => {
    await open(page, "/", "Experiments");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect.poll(() => activeElement(page)).toMatchObject({ isMain: true });
  });

  test("client-side navigation moves focus to main and announces the new page", async ({ page }, testInfo) => {
    await open(page, "/", "Experiments");
    // Initial load must not steal focus.
    expect((await activeElement(page)).tag).toBe("body");
    // Mark the shell: only the page may remount on navigation, never the header, navigation or main landmark.
    await page.evaluate(() => {
      document.querySelector("header")!.dataset.probe = "shell";
      document.getElementById("main")!.dataset.probe = "shell";
    });

    await navigateTo(page, "Calculator", testInfo);
    await expect(page.getByRole("heading", { level: 1, name: "Calculators" })).toBeVisible();
    await expect(page.locator("header"), "the header persists across client-side navigation").toHaveAttribute("data-probe", "shell");
    await expect(page.locator("#main"), "the main landmark persists across client-side navigation").toHaveAttribute("data-probe", "shell");
    await expect.poll(() => activeElement(page)).toMatchObject({ isMain: true });
    const announcer = page.locator('[role="status"][aria-live="polite"]').filter({ hasText: /Calculators/ });
    await expect(announcer).toHaveCount(1);
    await expect(announcer).toContainText(/Calculators/);

    await navigateTo(page, "Docs", testInfo);
    await expect(page.getByRole("heading", { level: 1, name: "Docs" })).toBeVisible();
    await expect.poll(() => activeElement(page)).toMatchObject({ isMain: true });
    await expect(page.locator('[role="status"][aria-live="polite"]').filter({ hasText: /Docs/ })).toHaveCount(1);

    // A page that focuses its own first field keeps that focus (the wizard autofocuses the name).
    await page.getByRole("link", { name: /new experiment|^new$/i }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "New experiment" })).toBeVisible();
    await expect.poll(() => activeElement(page)).toMatchObject({ inMain: true });
  });

  test("numeric fields are plain text inputs whose validation message is linked via aria-describedby", async ({ page }) => {
    await open(page, "/calculator", "Calculators");
    const field = page.getByRole("textbox", { name: /baseline rate/i }).first();
    for (const attr of ["min", "max", "step"]) await expect(field, `no ${attr} attribute on a text input`).not.toHaveAttribute(attr, /.*/);
    await expect(field).toHaveAttribute("inputmode", "decimal");
    await expect(field).toHaveAttribute("aria-invalid", "false");

    await field.fill("5");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = await field.getAttribute("aria-describedby");
    expect(describedBy, "aria-describedby set while invalid").toBeTruthy();
    const message = page.locator(`[id="${describedBy}"]`);
    await expect(message).toBeVisible();
    await expect(message).toHaveText(/enter a value between/i);
    await expect(message).toHaveAttribute("role", "alert");
    // The error is the description, not part of the name.
    await expect(field).toHaveAccessibleName(/^Baseline rate$/i);
    await expect(field).toHaveAccessibleDescription(/enter a value between/i);

    await field.fill("0.2");
    await expect(field).toHaveAttribute("aria-invalid", "false");
    await expect(field).toHaveAccessibleName(/^Baseline rate$/i);
  });
});
