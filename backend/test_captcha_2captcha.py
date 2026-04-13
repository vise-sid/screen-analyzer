"""
Test patchright on 2captcha's Cloudflare Turnstile demo.
Run: python test_captcha_2captcha.py
"""

import asyncio
from patchright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        print("Launching stealth browser...")
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        print("Navigating to 2captcha Turnstile demo...")
        await page.goto("https://2captcha.com/demo/cloudflare-turnstile", wait_until="domcontentloaded")
        print(f"URL: {page.url}")

        print("Waiting for Turnstile to render...")
        await page.wait_for_timeout(5000)

        for attempt in range(10):
            print(f"\n--- Attempt {attempt + 1} ---")
            await page.screenshot(path=f"2captcha_attempt_{attempt + 1}.png")

            # Check for success message on the 2captcha demo page
            try:
                body = await page.inner_text("body", timeout=2000)
                if "Captcha is passed successfully" in body or "token" in body.lower():
                    print("2captcha demo reports SUCCESS!")
                    break
            except Exception:
                pass

            # Find and click Turnstile iframe
            try:
                iframe_el = page.locator(
                    'iframe[src*="challenges.cloudflare.com"], .cf-turnstile iframe, iframe[src*="turnstile"]'
                )
                if await iframe_el.first.is_visible(timeout=2000):
                    box = await iframe_el.first.bounding_box()
                    if box:
                        click_x = box["x"] + 30
                        click_y = box["y"] + box["height"] / 2
                        print(f"  Turnstile iframe at: x={box['x']:.0f} y={box['y']:.0f} w={box['width']:.0f} h={box['height']:.0f}")
                        print(f"  Clicking at ({click_x:.0f}, {click_y:.0f})...")
                        await page.mouse.click(click_x, click_y)
                        print("  Clicked! Waiting...")
                        await page.wait_for_timeout(5000)
                    else:
                        print("  No bounding box")
                else:
                    print("  Turnstile iframe not visible")
            except Exception as e:
                print(f"  Error: {e}")

            # Try clicking the "Check" / submit button if Turnstile solved
            try:
                submit = page.locator('button:has-text("Check"), button[type="submit"], input[type="submit"]')
                if await submit.first.is_visible(timeout=500):
                    await submit.first.click(timeout=2000)
                    print("  Clicked submit button")
                    await page.wait_for_timeout(3000)
            except Exception:
                pass

        # Final state
        print("\n========== FINAL STATE ==========")
        print(f"URL: {page.url}")
        await page.screenshot(path="2captcha_final.png")
        print("Screenshot saved to 2captcha_final.png")

        try:
            body = await page.inner_text("body", timeout=2000)
            print(f"Page text preview: {body[:300]}")
        except Exception:
            pass

        print("\nBrowser stays open for 30 seconds...")
        await page.wait_for_timeout(30000)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
