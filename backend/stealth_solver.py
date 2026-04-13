"""
Stealth CAPTCHA/Cloudflare solver using patchright (patched Playwright).
Binary-level stealth — undetectable by Cloudflare, Akamai, DataDome.
"""

import asyncio
import logging

from patchright.async_api import async_playwright

logger = logging.getLogger(__name__)


async def solve_cloudflare(
    url: str,
    user_agent: str | None = None,
    cookies: list[dict] | None = None,
    timeout: int = 45,
) -> dict:
    """
    Open a URL in a stealth browser, solve Cloudflare/Turnstile, return cookies.
    Waits for full page load and cookie capture before closing.
    """
    async with async_playwright() as p:
        browser = None
        try:
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
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(3000)  # Let Turnstile render

            cf_clearance = None
            click_attempts = 0
            solved = False

            for i in range(timeout * 2):
                await asyncio.sleep(0.5)

                # Check cookies
                all_cookies = await context.cookies()
                for c in all_cookies:
                    if c["name"] == "cf_clearance":
                        cf_clearance = c["value"]

                if cf_clearance:
                    solved = True
                    break

                # Check if page content indicates challenge is passed
                try:
                    body_text = await page.inner_text("body", timeout=1000)
                    has_challenge = (
                        "Verify you are human" in body_text
                        or "Checking your browser" in body_text
                        or "Just a moment" in body_text
                    )
                    if not has_challenge and i > 10:
                        # Challenge text gone — likely solved
                        solved = True
                        break
                except Exception:
                    pass

                # Check URL change (redirected past challenge)
                try:
                    current = page.url
                    if current != url and "challenge" not in current and i > 6:
                        solved = True
                        break
                except Exception:
                    pass

                # Click the Turnstile checkbox every ~3 seconds
                if i % 6 == 3 and click_attempts < 5:
                    clicked = await _try_click_challenge(page)
                    if clicked:
                        click_attempts += 1
                        logger.info(f"Click attempt {click_attempts}/5")
                        await page.wait_for_timeout(3000)

            if solved:
                # CRITICAL: Wait for page to fully settle after solving
                logger.info("Challenge appears solved — waiting for page to settle...")
                await page.wait_for_timeout(5000)

                # Re-check cookies after waiting
                final_cookies_raw = await context.cookies()
                for c in final_cookies_raw:
                    if c["name"] == "cf_clearance":
                        cf_clearance = c["value"]

                final_cookies = _format_cookies(final_cookies_raw)
                final_url = page.url

                logger.info(
                    f"Solved! cf_clearance={'yes' if cf_clearance else 'no'}, "
                    f"cookies={len(final_cookies)}, url={final_url}"
                )

                await browser.close()
                return {
                    "success": True,
                    "cookies": final_cookies,
                    "cf_clearance": cf_clearance,
                    "final_url": final_url,
                    "error": None,
                }

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
            if browser:
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
    """Find and click Turnstile/reCAPTCHA checkbox."""
    try:
        # Strategy 1: Click inside Turnstile iframe
        turnstile = page.frame_locator(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
        )
        try:
            body = turnstile.locator("body")
            if await body.first.is_visible(timeout=1000):
                await body.first.click(timeout=2000)
                logger.info("Clicked inside Turnstile iframe body")
                return True
        except Exception:
            pass

        # Strategy 2: Click the Turnstile iframe element at checkbox position
        iframe_el = page.locator(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
        )
        try:
            if await iframe_el.first.is_visible(timeout=1000):
                box = await iframe_el.first.bounding_box()
                if box:
                    await page.mouse.click(
                        box["x"] + 30,
                        box["y"] + box["height"] / 2,
                    )
                    logger.info(f"Clicked Turnstile iframe at ({box['x'] + 30:.0f}, {box['y'] + box['height'] / 2:.0f})")
                    return True
        except Exception:
            pass

        # Strategy 3: reCAPTCHA
        recaptcha = page.frame_locator('iframe[src*="recaptcha/api2/anchor"]')
        try:
            checkbox = recaptcha.locator("#recaptcha-anchor")
            if await checkbox.first.is_visible(timeout=1000):
                await checkbox.first.click(timeout=2000)
                logger.info("Clicked reCAPTCHA anchor")
                return True
        except Exception:
            pass

        # Strategy 4: Any checkbox
        try:
            cb = page.locator('input[type="checkbox"]')
            if await cb.first.is_visible(timeout=500):
                await cb.first.click(timeout=2000)
                logger.info("Clicked generic checkbox")
                return True
        except Exception:
            pass

        return False

    except Exception as e:
        logger.warning(f"Click failed: {e}")
        return False


def _format_cookies(cookies: list[dict]) -> list[dict]:
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
