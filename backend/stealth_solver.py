"""
Stealth CAPTCHA solver using nodriver.
Spawns a stealth Chrome instance, navigates to the URL,
waits for Cloudflare/Turnstile to pass, extracts cookies.
"""

import asyncio
import nodriver as uc


async def solve_cloudflare(url: str, user_agent: str | None = None, cookies: list[dict] | None = None, timeout: int = 30) -> dict:
    """
    Open a URL in a stealth browser, wait for Cloudflare challenge to resolve,
    return all cookies.

    Args:
        url: The URL that's blocked by Cloudflare
        user_agent: Match the user's Chrome UA for cookie compatibility
        cookies: Existing cookies to inject before navigation
        timeout: Max seconds to wait for challenge resolution

    Returns:
        {
            "success": bool,
            "cookies": [{"name": ..., "value": ..., "domain": ..., ...}],
            "cf_clearance": str | None,
            "error": str | None,
        }
    """
    browser = None
    try:
        # Launch stealth Chrome
        config = uc.Config()
        if user_agent:
            config.add_argument(f"--user-agent={user_agent}")

        browser = await uc.start(config=config)

        # Get the first tab
        tab = browser.main_tab

        # Inject existing cookies if provided
        if cookies:
            for cookie in cookies:
                try:
                    await tab.send(uc.cdp.network.set_cookie(
                        name=cookie["name"],
                        value=cookie["value"],
                        domain=cookie.get("domain", ""),
                        path=cookie.get("path", "/"),
                        secure=cookie.get("secure", False),
                        http_only=cookie.get("httpOnly", False),
                    ))
                except Exception:
                    pass

        # Navigate to the URL
        await tab.get(url)

        # Wait for Cloudflare challenge to resolve
        # We check for cf_clearance cookie appearance
        cf_clearance = None
        for _ in range(timeout * 2):  # check every 0.5s
            await asyncio.sleep(0.5)

            # Get all cookies
            all_cookies_response = await tab.send(uc.cdp.network.get_all_cookies())
            cookie_list = []
            for c in all_cookies_response:
                cookie_dict = {
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain,
                    "path": c.path,
                    "secure": c.secure,
                    "httpOnly": c.http_only,
                    "sameSite": str(c.same_site) if c.same_site else None,
                }
                cookie_list.append(cookie_dict)

                if c.name == "cf_clearance":
                    cf_clearance = c.value

            # Check if the page has moved past the challenge
            # (URL changed, or challenge element disappeared)
            if cf_clearance:
                return {
                    "success": True,
                    "cookies": cookie_list,
                    "cf_clearance": cf_clearance,
                    "error": None,
                }

        # Timeout — return whatever cookies we have
        all_cookies_response = await tab.send(uc.cdp.network.get_all_cookies())
        cookie_list = []
        for c in all_cookies_response:
            cookie_list.append({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "secure": c.secure,
                "httpOnly": c.http_only,
            })

        return {
            "success": False,
            "cookies": cookie_list,
            "cf_clearance": None,
            "error": f"Timeout after {timeout}s — Cloudflare challenge not resolved",
        }

    except Exception as e:
        return {
            "success": False,
            "cookies": [],
            "cf_clearance": None,
            "error": str(e),
        }
    finally:
        if browser:
            try:
                browser.stop()
            except Exception:
                pass


async def test():
    """Quick test against nowsecure.nl"""
    print("Launching stealth browser...")
    result = await solve_cloudflare("https://nowsecure.nl", timeout=20)
    print(f"Success: {result['success']}")
    print(f"cf_clearance: {result['cf_clearance']}")
    print(f"Total cookies: {len(result['cookies'])}")
    if result['error']:
        print(f"Error: {result['error']}")
    for c in result['cookies']:
        print(f"  {c['name']} = {c['value'][:40]}...")


if __name__ == "__main__":
    asyncio.run(test())
