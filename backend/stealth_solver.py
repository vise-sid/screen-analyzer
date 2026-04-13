"""
Stealth CAPTCHA/Cloudflare solver using nodriver.
Spawns a stealth Chrome instance, navigates to the URL,
waits for Cloudflare/Turnstile challenge to auto-resolve,
extracts cookies (including cf_clearance) and returns them.
"""

import asyncio
import logging

import nodriver as uc

logger = logging.getLogger(__name__)


async def solve_cloudflare(
    url: str,
    user_agent: str | None = None,
    cookies: list[dict] | None = None,
    timeout: int = 30,
) -> dict:
    """
    Open a URL in a stealth browser, wait for Cloudflare to pass, return cookies.

    Returns:
        {
            "success": bool,
            "cookies": [{"name", "value", "domain", "path", "secure", "httpOnly"}],
            "cf_clearance": str | None,
            "final_url": str | None,
            "error": str | None,
        }
    """
    browser = None
    try:
        config = uc.Config()
        config.add_argument("--no-first-run")
        config.add_argument("--no-default-browser-check")
        config.add_argument("--disable-popup-blocking")
        if user_agent:
            config.add_argument(f"--user-agent={user_agent}")

        browser = await uc.start(config=config)
        tab = browser.main_tab

        # Enable network for cookie access
        await tab.send(uc.cdp.network.enable())

        # Inject existing cookies before navigation
        if cookies:
            for c in cookies:
                try:
                    await tab.send(uc.cdp.network.set_cookie(
                        name=c["name"],
                        value=c["value"],
                        domain=c.get("domain", ""),
                        path=c.get("path", "/"),
                        secure=c.get("secure", False),
                        http_only=c.get("httpOnly", False),
                    ))
                except Exception:
                    pass

        # Navigate
        await tab.get(url)

        # Poll for cf_clearance cookie or page change
        cf_clearance = None
        for i in range(timeout * 2):
            await asyncio.sleep(0.5)

            try:
                # Use storage API instead of deprecated get_all_cookies
                all_cookies = await tab.send(uc.cdp.storage.get_cookies())
            except Exception:
                # Fallback to network API
                try:
                    all_cookies = await tab.send(uc.cdp.network.get_cookies())
                except Exception:
                    continue

            cookie_list = []
            for c in all_cookies:
                cookie_list.append({
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain,
                    "path": c.path,
                    "secure": c.secure,
                    "httpOnly": c.http_only,
                    "sameSite": str(c.same_site) if c.same_site else None,
                })
                if c.name == "cf_clearance":
                    cf_clearance = c.value

            if cf_clearance:
                # Wait a bit more for page to fully load after challenge
                await asyncio.sleep(1)
                final_url = None
                try:
                    final_url = tab.url
                except Exception:
                    pass

                logger.info(f"Cloudflare solved in {(i + 1) * 0.5:.1f}s")
                return {
                    "success": True,
                    "cookies": cookie_list,
                    "cf_clearance": cf_clearance,
                    "final_url": final_url,
                    "error": None,
                }

            # Also check if the page navigated past the challenge
            # (some sites don't use cf_clearance but redirect after passing)
            try:
                current_url = tab.url
                if current_url and current_url != url and "challenge" not in current_url:
                    # Page moved — challenge likely passed
                    all_cookies = await tab.send(uc.cdp.storage.get_cookies())
                    cookie_list = []
                    for c in all_cookies:
                        cookie_list.append({
                            "name": c.name,
                            "value": c.value,
                            "domain": c.domain,
                            "path": c.path,
                            "secure": c.secure,
                            "httpOnly": c.http_only,
                        })
                        if c.name == "cf_clearance":
                            cf_clearance = c.value

                    return {
                        "success": True,
                        "cookies": cookie_list,
                        "cf_clearance": cf_clearance,
                        "final_url": current_url,
                        "error": None,
                    }
            except Exception:
                pass

        # Timeout
        return {
            "success": False,
            "cookies": [],
            "cf_clearance": None,
            "final_url": None,
            "error": f"Timeout after {timeout}s — challenge not resolved",
        }

    except Exception as e:
        logger.error(f"Stealth solver error: {e}")
        return {
            "success": False,
            "cookies": [],
            "cf_clearance": None,
            "final_url": None,
            "error": str(e),
        }
    finally:
        if browser:
            try:
                browser.stop()
            except Exception:
                pass
