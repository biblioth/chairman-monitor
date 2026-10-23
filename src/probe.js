import { parseChairmanAvailability } from "./parser.js";
const DEFAULT_QUEUE_URL =
  "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";
const DEFAULT_BOOKING_URL = "https://www.thechairmangroup.com/index.php?route=catering/booking";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  const values = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : fallback;
}

function responseLocation(response, currentUrl) {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

function responseCookies(response) {
  const headers = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return headers
    .flatMap((value) => String(value).split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(current, additions) {
  const values = new Map();
  for (const cookieHeader of [current, additions]) {
    for (const item of String(cookieHeader || "").split(";")) {
      const trimmed = item.trim();
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function isChairmanBookingUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "www.thechairmangroup.com" && url.searchParams.get("route") === "catering/booking";
  } catch {
    return false;
  }
}

function safeRedirectDescription(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}${url.searchParams.has("route") ? `?route=${url.searchParams.get("route")}` : ""}`;
  } catch {
    return "invalid redirect URL";
  }
}

function titleFromHtml(html) {
  return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function isBrowserTabReloadPage(pageTitle, html) {
  return /^auto reload$/i.test(pageTitle || "") &&
    /params\.set\(\s*["']btabid["']/i.test(html || "");
}

function pageFingerprint(html) {
  let hash = 2166136261;
  for (let index = 0; index < html.length; index += 1) {
    hash ^= html.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fetchOptions(timeoutMs, extraHeaders = {}) {
  return {
    redirect: "manual",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
}

async function queuePass(queueUrl, fetcher, timeoutMs) {
  const first = await fetcher(queueUrl, fetchOptions(timeoutMs));
  const firstLocation = responseLocation(first, queueUrl);
  if (isChairmanBookingUrl(firstLocation)) return firstLocation;
  if (!firstLocation) {
    const body = await first.text();
    return {
      status: "busy",
      httpStatus: first.status,
      pageTitle: titleFromHtml(body),
      error: `Queue-it did not issue a redirect (HTTP ${first.status})`,
    };
  }

  const cookies = responseCookies(first);
  const second = await fetcher(
    firstLocation,
    fetchOptions(timeoutMs, cookies ? { cookie: cookies, referer: queueUrl } : { referer: queueUrl }),
  );
  const secondLocation = responseLocation(second, firstLocation);
  if (isChairmanBookingUrl(secondLocation)) return secondLocation;
  if (!secondLocation) {
    const body = await second.text();
    return {
      status: "busy",
      httpStatus: second.status,
      pageTitle: titleFromHtml(body),
      error: `Queue-it after-event page did not issue a booking redirect (HTTP ${second.status})`,
    };
  }
  return {
    status: "error",
    httpStatus: second.status,
    error: `Unexpected Queue-it redirect host: ${new URL(secondLocation).hostname}`,
  };
}

export async function fetchChairmanAvailability(env, fetcher = fetch) {
  const queueUrl = env.CHAIRMAN_QUEUE_URL || DEFAULT_QUEUE_URL;
  const bookingUrl = env.CHAIRMAN_BOOKING_URL || DEFAULT_BOOKING_URL;
  const timeoutMs = integer(env.CHAIRMAN_FETCH_TIMEOUT_MS, 45_000);
  const targetDates = list(env.CHAIRMAN_TARGET_DATES, ["2026-10-30", "2026-10-31", "2026-11-01"]);
  const mealWindows = list(env.CHAIRMAN_MEAL_WINDOWS, ["lunch", "dinner"]);
  const partySize = integer(env.CHAIRMAN_PARTY_SIZE, 2);

  let pass;
  try {
    pass = await queuePass(queueUrl, fetcher, timeoutMs);
  } catch (error) {
    return {
      status: "error",
      error: `Queue-it request failed: ${error instanceof Error ? error.message : String(error)}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  if (typeof pass !== "string") {
    return { ...pass, targetDates, mealWindows, partySize, sourceUrl: queueUrl };
  }

  let response;
  let currentUrl = pass;
  let originCookies = "";
  try {
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      response = await fetcher(
        currentUrl,
        fetchOptions(timeoutMs, {
          referer: redirectCount ? bookingUrl : queueUrl,
          ...(originCookies ? { cookie: originCookies } : {}),
        }),
      );
      originCookies = mergeCookies(originCookies, responseCookies(response));
      if (response.status < 300 || response.status >= 400) break;
      const location = responseLocation(response, currentUrl);
      if (!location) {
        return {
          status: "error",
          error: `Chairman booking page returned HTTP ${response.status} without Location`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      const hostname = new URL(location).hostname;
      if (hostname === "thechairmangroup.queue-it.net") {
        return {
          status: "busy",
          error: `Chairman sent the request back to Queue-it (${safeRedirectDescription(location)})`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      if (hostname !== "www.thechairmangroup.com") {
        return {
          status: "error",
          error: `Unexpected Chairman redirect: ${safeRedirectDescription(location)}`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      currentUrl = location;
    }
  } catch (error) {
    return {
      status: "busy",
      error: `Chairman booking page timed out: ${error instanceof Error ? error.message : String(error)}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  if (!response) {
    return {
      status: "error",
      error: "Chairman booking request did not return a response",
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  let html = await response.text();
  let pageTitle = titleFromHtml(html);
  for (let reloadCount = 0; reloadCount < 2 && isBrowserTabReloadPage(pageTitle, html); reloadCount += 1) {
    const reloadUrl = new URL(currentUrl);
    reloadUrl.searchParams.set("btabid", String(Math.floor(Math.random() * 10_000)));
    let reloadCurrentUrl = reloadUrl.toString().replaceAll("%2F", "/");
    try {
      for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
        response = await fetcher(
          reloadCurrentUrl,
          fetchOptions(timeoutMs, {
            referer: currentUrl,
            ...(originCookies ? { cookie: originCookies } : {}),
          }),
        );
        originCookies = mergeCookies(originCookies, responseCookies(response));
        if (response.status < 300 || response.status >= 400) break;
        const location = responseLocation(response, reloadCurrentUrl);
        if (!location) {
          return {
            status: "error",
            error: `Chairman browser-tab reload returned HTTP ${response.status} without Location`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        const hostname = new URL(location).hostname;
        if (hostname === "thechairmangroup.queue-it.net") {
          return {
            status: "busy",
            error: `Chairman browser-tab reload returned to Queue-it (${safeRedirectDescription(location)})`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        if (hostname !== "www.thechairmangroup.com") {
          return {
            status: "error",
            error: `Unexpected Chairman browser-tab reload redirect: ${safeRedirectDescription(location)}`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        reloadCurrentUrl = location;
      }
    } catch (error) {
      return {
        status: "busy",
        error: `Chairman browser-tab reload timed out: ${error instanceof Error ? error.message : String(error)}`,
        targetDates,
        mealWindows,
        partySize,
        sourceUrl: queueUrl,
      };
    }
    currentUrl = reloadCurrentUrl;
    html = await response.text();
    pageTitle = titleFromHtml(html);
  }
  const debug = {
    httpStatus: response.status,
    pageTitle,
    pageBytes: new TextEncoder().encode(html).length,
    pageFingerprint: pageFingerprint(html),
    pagePreview: response.status === 405
      ? html.replace(/\s+/g, " ").slice(0, 3000)
      : null,
  };
  if (isBrowserTabReloadPage(pageTitle, html)) {
    return {
      status: "busy",
      error: "Chairman booking gate requested another browser-tab reload",
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }
  if (
    response.status === 429 ||
    /server\s*busy|currently\s*experiencing\s*high\s*traffic|系統非常繁忙|系统非常繁忙/i.test(html)
  ) {
    return {
      status: "busy",
      error: `Chairman booking server is busy (HTTP ${response.status})`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }
  if (!response.ok) {
    return {
      status: "error",
      error: `Chairman booking page returned HTTP ${response.status}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }

  try {
    const parsed = parseChairmanAvailability(html, {
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    });
    return {
      ...parsed,
      bookingPageUrl: bookingUrl,
      ...debug,
    };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
      targetDates,
      mealWindows,
      partySize,
      observations: [],
      available: [],
      unknown: [],
      sourceUrl: queueUrl,
      ...debug,
    };
  }
}

