"""
Stealth CAPTCHA/Cloudflare solver using patchright (patched Playwright).
Binary-level stealth — undetectable by Cloudflare, Akamai, DataDome.
Proper Playwright APIs for reliable page interaction.
"""

import asyncio
import logging

from patchright.async_api import async_playwright

logger = logging.getLogger(__name__)


async def solve_cloudflare(
    url: str,
    user_agent: str | None = None,
    cookies: list[dict] | None = None,
    timeout: int = 30,
) -> dict:
    """
    Open a URL in a stealth browser, solve Cloudflare/Turnstile, return cookies.
    """
    async with async_playwright() as p:
        try:
            # Launch patched Chromium (visible so user can see what's happening)
            browser = await p.chromium.launch(
                headless=False,
                args=[
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-popup-blocking",
                ],
            )

            context = await browser.new_context(
                user_agent=user_agent or None,
                viewport={"width": 1280, "height": 800},
            )

            # Inject existing cookies
            if cookies:
                pw_cookies = []
                for c in cookies:
                    domain = c.get("domain", "")
                    if not domain:
                        continue
                    pw_cookie = {
                        "name": c["name"],
                        "value": c["value"],
                        "domain": domain,
                        "path": c.get("path", "/"),
                        "secure": c.get("secure", False),
                        "httpOnly": c.get("httpOnly", False),
                    }
                    same_site = c.get("sameSite", "")
                    if same_site in ("Strict", "Lax", "None"):
                        pw_cookie["sameSite"] = same_site
                    pw_cookies.append(pw_cookie)

                if pw_cookies:
                    await context.add_cookies(pw_cookies)

            page = await context.new_page()

            # Navigate
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(2000)

            # Try to solve the challenge
            cf_clearance = None
            click_attempts = 0

            for i in range(timeout * 2):
                await asyncio.sleep(0.5)

                # Check cookies for cf_clearance
                all_cookies = await context.cookies()
                for c in all_cookies:
                    if c["name"] == "cf_clearance":
                        cf_clearance = c["value"]

                if cf_clearance:
                    await page.wait_for_timeout(1000)
                    final_cookies = _format_cookies(await context.cookies())
                    logger.info(f"Cloudflare solved in {(i + 1) * 0.5:.1f}s")
                    await browser.close()
                    return {
                        "success": True,
                        "cookies": final_cookies,
                        "cf_clearance": cf_clearance,
                        "final_url": page.url,
                        "error": None,
                    }

                # Check if page navigated past challenge
                if "challenge" not in page.url and page.url != url:
                    final_cookies = _format_cookies(await context.cookies())
                    for c in final_cookies:
                        if c["name"] == "cf_clearance":
                            cf_clearance = c["value"]
                    await browser.close()
                    return {
                        "success": True,
                        "cookies": final_cookies,
                        "cf_clearance": cf_clearance,
                        "final_url": page.url,
                        "error": None,
                    }

                # Try clicking the Turnstile checkbox every 2 seconds
                if i % 4 == 2 and click_attempts < 5:
                    clicked = await _try_click_challenge(page)
                    if clicked:
                        click_attempts += 1
                        logger.info(f"Click attempt {click_attempts}/5")
                        await page.wait_for_timeout(2000)

            # Timeout
            final_cookies = _format_cookies(await context.cookies())
            await browser.close()
            return {
                "success": False,
                "cookies": final_cookies,
                "cf_clearance": None,
                "final_url": page.url,
                "error": f"Timeout after {timeout}s — {click_attempts} click attempts",
            }

        except Exception as e:
            logger.error(f"Stealth solver error: {e}")
            try:
                await browser.close()
            except Exception:
                pass
            return {
                "success": False,
                "cookies": [],
                "cf_clearance": None,
                "final_url": None,
                "error": str(e),
            }


async def _try_click_challenge(page) -> bool:
    """Find and click Turnstile/reCAPTCHA checkbox using Playwright's proper APIs."""
    try:
        # Strategy 1: Turnstile iframe
        turnstile = page.frame_locator(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
        )
        try:
            checkbox = turnstile.locator('input[type="checkbox"], .cb-i, label, body')
            if await checkbox.first.is_visible(timeout=1000):
                await checkbox.first.click(timeout=2000)
                logger.info("Clicked Turnstile checkbox inside iframe")
                return True
        except Exception:
            pass

        # Strategy 2: Click the Turnstile iframe element itself
        turnstile_iframe = page.locator(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
        )
        try:
            if await turnstile_iframe.first.is_visible(timeout=1000):
                box = await turnstile_iframe.first.bounding_box()
                if box:
                    # Click near the left side where the checkbox is
                    await page.mouse.click(
                        box["x"] + 30,
                        box["y"] + box["height"] / 2,
                    )
                    logger.info(f"Clicked Turnstile iframe at ({box['x'] + 30:.0f}, {box['y'] + box['height'] / 2:.0f})")
                    return True
        except Exception:
            pass

        # Strategy 3: reCAPTCHA iframe
        recaptcha = page.frame_locator('iframe[src*="recaptcha/api2/anchor"]')
        try:
            checkbox = recaptcha.locator('.recaptcha-checkbox-border, #recaptcha-anchor')
            if await checkbox.first.is_visible(timeout=1000):
                await checkbox.first.click(timeout=2000)
                logger.info("Clicked reCAPTCHA checkbox")
                return True
        except Exception:
            pass

        # Strategy 4: Any visible "Verify" button
        try:
            verify_btn = page.locator('text="Verify you are human"')
            if await verify_btn.first.is_visible(timeout=500):
                await verify_btn.first.click(timeout=2000)
                logger.info("Clicked 'Verify you are human'")
                return True
        except Exception:
            pass

        # Strategy 5: Any checkbox on the page
        try:
            checkboxes = page.locator('input[type="checkbox"]')
            if await checkboxes.first.is_visible(timeout=500):
                await checkboxes.first.click(timeout=2000)
                logger.info("Clicked generic checkbox")
                return True
        except Exception:
            pass

        return False

    except Exception as e:
        logger.warning(f"Click attempt failed: {e}")
        return False


def _format_cookies(cookies: list[dict]) -> list[dict]:
    """Format Playwright cookies to our standard format."""
    return [
        {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "secure": c.get("secure", False),
            "httpOnly": c.get("httpOnly", False),
            "sameSite": c.get("sameSite"),
        }
        for c in cookies
    ]
