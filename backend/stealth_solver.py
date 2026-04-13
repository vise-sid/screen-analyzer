"""
Stealth CAPTCHA/Cloudflare solver using patchright (patched Playwright).
Proven to pass both nowsecure.nl and 2captcha.com/demo/cloudflare-turnstile.
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
    async with async_playwright() as p:
        browser = None
        try:
            browser = await p.chromium.launch(headless=False)

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

            # Wait for Turnstile to render
            await page.wait_for_timeout(5000)

            click_attempts = 0

            for i in range(timeout * 2):
                await asyncio.sleep(0.5)

                # Check cf_clearance cookie
                all_cookies = await context.cookies()
                cf_clearance = None
                for c in all_cookies:
                    if c["name"] == "cf_clearance":
                        cf_clearance = c["value"]

                if cf_clearance:
                    # Wait for page to fully settle
                    await page.wait_for_timeout(3000)
                    final_cookies = _format_cookies(await context.cookies())
                    logger.info(f"Solved via cf_clearance in {(i + 1) * 0.5:.1f}s")
                    await browser.close()
                    return _success(final_cookies, cf_clearance, page.url)

                # Check if challenge text is gone (auto-solved or solved)
                try:
                    body = await page.inner_text("body", timeout=1000)
                    has_challenge = (
                        "Verify you are human" in body
                        or "Checking your browser" in body
                        or "Just a moment" in body
                    )
                    # Also check for success indicators
                    has_success = (
                        "Success" in body
                        or "Captcha is passed" in body
                    )

                    if has_success or (not has_challenge and i > 10):
                        await page.wait_for_timeout(3000)
                        final_cookies = _format_cookies(await context.cookies())
                        for c in final_cookies:
                            if c["name"] == "cf_clearance":
                                cf_clearance = c["value"]
                        logger.info(f"Solved via page content in {(i + 1) * 0.5:.1f}s")
                        await browser.close()
                        return _success(final_cookies, cf_clearance, page.url)
                except Exception:
                    pass

                # Click the Turnstile checkbox every ~5 seconds
                if i % 10 == 5 and click_attempts < 5:
                    try:
                        iframe_el = page.locator(
                            'iframe[src*="challenges.cloudflare.com"], '
                            '.cf-turnstile iframe, '
                            'iframe[src*="turnstile"]'
                        )
                        if await iframe_el.first.is_visible(timeout=1000):
                            box = await iframe_el.first.bounding_box()
                            if box:
                                click_x = box["x"] + 30
                                click_y = box["y"] + box["height"] / 2
                                await page.mouse.click(click_x, click_y)
                                click_attempts += 1
                                logger.info(
                                    f"Click {click_attempts}/5 at ({click_x:.0f}, {click_y:.0f})"
                                )
                                await page.wait_for_timeout(5000)
                    except Exception as e:
                        logger.warning(f"Click failed: {e}")

            # Timeout — return whatever we have
            final_cookies = _format_cookies(await context.cookies())
            await browser.close()
            return {
                "success": False,
                "cookies": final_cookies,
                "cf_clearance": None,
                "final_url": page.url,
                "error": f"Timeout after {timeout}s — {click_attempts} clicks attempted",
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


def _success(cookies, cf_clearance, url):
    return {
        "success": True,
        "cookies": cookies,
        "cf_clearance": cf_clearance,
        "final_url": url,
        "error": None,
    }


def _format_cookies(cookies):
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
