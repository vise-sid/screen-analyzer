"""
Standalone test: open nowsecure.nl with patchright and actually click the Turnstile checkbox.
Run: python test_captcha.py
"""

import asyncio
from patchright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        print("Launching stealth browser...")
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        print("Navigating to nowsecure.nl...")
        await page.goto("https://nowsecure.nl", wait_until="domcontentloaded")
        print(f"Page loaded. URL: {page.url}")

        # Wait for Turnstile to fully render
        print("Waiting for Turnstile to render...")
        await page.wait_for_timeout(5000)

        for attempt in range(10):
            print(f"\n--- Attempt {attempt + 1} ---")

            # Screenshot before click
            await page.screenshot(path=f"captcha_attempt_{attempt + 1}.png")

            # Check if already solved (green checkmark)
            try:
                # Check inside the Turnstile iframe for success state
                frame = page.frame_locator('iframe[src*="challenges.cloudflare.com"]')
                success = frame.locator('[id="success"], [class*="success"], [aria-checked="true"]')
                if await success.first.is_visible(timeout=500):
                    print("Turnstile shows SUCCESS inside iframe!")
                    break
            except Exception:
                pass

            # Check if the checkbox appears checked visually
            try:
                iframe_el = page.locator('iframe[src*="challenges.cloudflare.com"], .cf-turnstile iframe')
                if await iframe_el.first.is_visible(timeout=1000):
                    box = await iframe_el.first.bounding_box()
                    if box:
                        print(f"  Turnstile iframe at: x={box['x']:.0f} y={box['y']:.0f} w={box['width']:.0f} h={box['height']:.0f}")

                        # Click at the checkbox position (left side, vertically centered)
                        click_x = box["x"] + 30
                        click_y = box["y"] + box["height"] / 2
                        print(f"  Clicking at ({click_x:.0f}, {click_y:.0f})...")

                        await page.mouse.click(click_x, click_y)
                        print("  Clicked! Waiting for verification...")
                        await page.wait_for_timeout(5000)
                    else:
                        print("  Iframe has no bounding box")
                else:
                    print("  Turnstile iframe not visible")
            except Exception as e:
                print(f"  Click failed: {e}")

            # Check cookies after each attempt
            cookies = await page.context.cookies()
            cf = [c for c in cookies if c["name"] == "cf_clearance"]
            if cf:
                print(f"  cf_clearance found!")

        # Final state
        print("\n========== FINAL STATE ==========")
        print(f"URL: {page.url}")
        cookies = await page.context.cookies()
        for c in cookies:
            print(f"  Cookie: {c['name']} = {c['value'][:50]}...")
        cf = [c for c in cookies if c["name"] == "cf_clearance"]
        print(f"cf_clearance: {'YES' if cf else 'NO'}")

        await page.screenshot(path="captcha_final.png")
        print("Screenshot saved to captcha_final.png")

        print("\nBrowser stays open for 30 seconds — check the result...")
        await page.wait_for_timeout(30000)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
