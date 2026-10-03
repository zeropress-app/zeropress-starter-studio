(() => {
"use strict";

const COMMENTS_PER_PAGE_DEFAULT = 50;
const WORDPRESS_COMMENTS_MAX_PAGES = 3;
const COMMENT_CHALLENGE_DEFAULTS = {
  read: { maxMs: 2000, retries: 5 },
  write: { maxMs: 3000, retries: 5 },
};
const COMMENT_CHALLENGE_ERROR_CODES = new Set([
  "MISSING_COMMENT_CHALLENGE",
  "INVALID_COMMENT_CHALLENGE",
  "EXPIRED_COMMENT_CHALLENGE",
  "COMMENT_CHALLENGE_ALREADY_USED",
  "INVALID_TURNSTILE_TOKEN",
]);
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_TIMEOUT_MS = 120000;
// Supabase remains a lazy, operator-enabled dependency. Pin both the exact
// browser bundle and its digest so guest comments do not depend on mutable CDN code.
const SUPABASE_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.5";
const SUPABASE_SCRIPT_INTEGRITY = "sha384-Fntl9b+IRzm2GKZK0c129fQFknWsn8pyxDejLO4wwds1LF9DSob2K2QXlfw8EIXn";
const SUPABASE_SCRIPT_TIMEOUT_MS = 15000;
const SUPABASE_PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9._-]{16,512}$/;
let turnstileScriptPromise = null;
let supabaseScriptPromise = null;

class CommentDataError extends Error {
  constructor(messages) {
    const normalizedMessages = Array.isArray(messages) && messages.length > 0
      ? messages.map(normalizeCommentErrorMessage)
      : ["Something went wrong. Please try again."];
    super(normalizedMessages[0]);
    this.name = "CommentDataError";
    this.messages = normalizedMessages;
  }
}

class WordPressCommentData {
  constructor(config) {
    this.provider = config.provider;
    this.apiBaseUrl = config.apiBaseUrl;
    this.targetType = config.targetType;
    this.targetPublicId = config.targetPublicId;
    this.perPage = normalizePositiveInteger(config.perPage) || COMMENTS_PER_PAGE_DEFAULT;
    this.order = normalizeCommentsOrder(config.order) || "desc";
  }

  async load() {
    const comments = [];

    for (let page = 1; page <= WORDPRESS_COMMENTS_MAX_PAGES; page += 1) {
      const response = await fetchJson(buildWordPressEndpoint(this, {
        perPage: this.perPage,
        page,
        orderby: "date",
      }));

      if (!response.ok || !Array.isArray(response.payload)) {
        throw createCommentDataError(response.payload, "Comments are temporarily unavailable.");
      }

      comments.push(...normalizeWordPressComments(response.payload));
      if (response.payload.length < this.perPage) {
        break;
      }
    }

    return {
      comments,
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalComments: comments.length,
      },
    };
  }

  async submit(input) {
    const body = new FormData();
    if (input.parentId) {
      body.set("parent", input.parentId);
    }
    body.set("author_name", input.authorName);
    body.set("author_email", input.authorEmail);
    body.set("content", input.content);

    let response;
    try {
      response = await fetchJson(buildWordPressEndpoint(this), {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
      });
    } catch {
      throw new CommentDataError([
        "Unable to submit the comment. Check your network connection and try again.",
      ]);
    }

    if (!response.ok || !isWordPressCommentPayload(response.payload)) {
      throw createCommentDataError(response.payload);
    }

    return {
      publication: response.payload.status === "approved"
        ? "published"
        : "pending_moderation",
    };
  }
}

class ZeroPressCommentData {
  constructor(config) {
    this.provider = config.provider;
    this.apiBaseUrl = config.apiBaseUrl;
    this.targetType = config.targetType;
    this.targetPublicId = config.targetPublicId;
    this.requestToken = config.requestToken;
    this.challengeSettings = normalizeChallengeSettings(config.challenge);
    this.challengeCache = { read: null, write: null };
    this.identityAdapter = null;
    this.identityState = createGuestIdentityState(false);
  }

  async initializeIdentity(onChange) {
    const notify = typeof onChange === "function" ? onChange : () => {};
    let discovery;
    try {
      discovery = await fetchCommentAuthDiscovery(this);
    } catch {
      notify(this.identityState);
      return this.identityState;
    }

    if (!discovery) {
      notify(this.identityState);
      return this.identityState;
    }

    try {
      const adapter = new SupabaseCommentIdentityAdapter(discovery, (state) => {
        this.identityState = state;
        notify(state);
      });
      this.identityAdapter = adapter;
      this.identityState = await adapter.initialize();
      notify(this.identityState);
    } catch {
      this.identityAdapter = null;
      this.identityState = createGuestIdentityState(false);
      notify(this.identityState);
    }
    return this.identityState;
  }

  getIdentityState() {
    return { ...this.identityState };
  }

  async requestIdentitySignIn(email) {
    if (!this.identityAdapter) {
      throw new CommentDataError(["Optional sign-in is not available."]);
    }
    return this.identityAdapter.requestMagicLink(email);
  }

  async signOutIdentity() {
    if (!this.identityAdapter) return this.identityState;
    return this.identityAdapter.signOut();
  }

  async load(page = 1, retryChallenge = true) {
    const challengeResult = await this.getSolvedChallenge("read");
    if (!challengeResult.challenge) {
      throw new CommentDataError([
        challengeResult.message || "Comments are temporarily unavailable.",
      ]);
    }

    const response = await fetchJson(buildZeroPressCommentsEndpoint(this, {
      page,
      challenge: challengeResult.challenge,
    }));

    if (!response.ok && retryChallenge && isCommentChallengeError(response.payload)) {
      this.challengeCache.read = null;
      return this.load(page, false);
    }

    if (!response.ok) {
      throw createCommentDataError(response.payload, "Comments are temporarily unavailable.");
    }

    const result = normalizeZeroPressCommentsPayload(response.payload, page);
    if (!result) {
      throw createCommentDataError(response.payload, "Comments are temporarily unavailable.");
    }
    return result;
  }

  async submit(input, retryChallenge = true) {
    const accessToken = await this.getIdentityAccessToken();
    const verificationResult = await this.getWriteVerification(input.verificationTarget);
    if (!verificationResult.verification) {
      throw new CommentDataError([
        verificationResult.message || "Comments are temporarily unavailable.",
      ]);
    }

    let response;
    try {
      response = await fetchJson(buildZeroPressCommentsEndpoint(this, {
        includeRequestToken: false,
        includeChallenge: false,
      }), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          ...(input.parentId ? { parent_id: Number(input.parentId) } : {}),
          author_name: input.authorName,
          ...(!accessToken ? { author_email: input.authorEmail } : {}),
          content_text: input.content,
          comment_request_token: this.requestToken,
          ...verificationResult.verification.body,
        }),
      });
    } catch {
      throw new CommentDataError([
        "Unable to submit the comment. Check your network connection and try again.",
      ]);
    }

    if (!response.ok && retryChallenge && isCommentChallengeError(response.payload)) {
      this.challengeCache.write = null;
      return this.submit(input, false);
    }

    const payload = unwrapZeroPressApiData(response.payload);
    if (!response.ok || !isZeroPressSubmissionPayload(payload)) {
      throw createCommentDataError(response.payload);
    }

    return { publication: payload.publication };
  }

  async getIdentityAccessToken() {
    if (!this.identityAdapter) return "";
    return this.identityAdapter.getAccessToken();
  }

  async getWriteVerification(verificationTarget) {
    const settings = this.challengeSettings.write;
    let lastMessage = "Comment verification took too long. Try again.";

    for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
      const descriptorResult = await fetchCommentWriteVerification(this);
      if (!descriptorResult.descriptor) {
        return { verification: null, message: descriptorResult.message };
      }

      const descriptor = descriptorResult.descriptor;
      if (descriptor.mode === "turnstile") {
        try {
          const token = await executeTurnstile(descriptor.turnstile, verificationTarget);
          return {
            verification: {
              mode: "turnstile",
              body: { turnstile_token: token },
            },
            message: "",
          };
        } catch (error) {
          return {
            verification: null,
            message: error?.message || "Comment verification failed. Try again.",
          };
        }
      }

      const result = await solveCommentChallenge(
        descriptor.pow.challenge_token,
        descriptor.pow.difficulty,
        settings.maxMs,
      );
      if (result.solution) {
        return {
          verification: {
            mode: "pow",
            body: {
              comment_challenge_token: descriptor.pow.challenge_token,
              comment_challenge_solution: result.solution,
            },
          },
          message: "",
        };
      }

      lastMessage = result.timedOut
        ? "Comment verification took too long. Try again."
        : "Comment verification failed. Try again.";
    }

    return { verification: null, message: lastMessage };
  }

  async getSolvedChallenge(scope, forceRefresh = false) {
    const useCachedChallenge = scope !== "write";
    const existing = useCachedChallenge ? this.challengeCache[scope] : null;
    if (!forceRefresh && hasFreshCommentChallenge(existing)) {
      return { challenge: existing, message: "" };
    }

    const settings = this.challengeSettings[scope] || this.challengeSettings.read;
    let lastResult = {
      challenge: null,
      message: "Comments are temporarily unavailable.",
      timedOut: false,
    };

    for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
      const result = await fetchCommentChallenge(this, scope, settings.maxMs);
      if (result.challenge) {
        this.challengeCache[scope] = useCachedChallenge ? result.challenge : null;
        return result;
      }

      lastResult = result;
      this.challengeCache[scope] = null;
      if (!result.timedOut) {
        return result;
      }
    }

    return lastResult;
  }
}

class SupabaseCommentIdentityAdapter {
  constructor(config, onChange) {
    this.config = config;
    this.onChange = onChange;
    this.client = null;
    this.state = createGuestIdentityState(true);
    this.subscription = null;
  }

  async initialize() {
    await loadSupabaseApi();
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("Supabase Auth is unavailable.");
    }

    this.client = window.supabase.createClient(
      this.config.projectUrl,
      this.config.publishableKey,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      },
    );

    const sessionResult = await this.client.auth.getSession();
    if (sessionResult?.error) throw sessionResult.error;
    this.setSession(sessionResult?.data?.session ?? null);

    const authChangeResult = this.client.auth.onAuthStateChange((_event, session) => {
      this.setSession(session ?? null);
    });
    this.subscription = authChangeResult?.data?.subscription ?? null;
    return this.state;
  }

  async requestMagicLink(value) {
    const email = normalizeAuthEmail(value);
    if (!email) {
      throw new CommentDataError(["Enter a valid email address to sign in."]);
    }
    if (!this.client) {
      throw new CommentDataError(["Optional sign-in is not available."]);
    }

    const result = await this.client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: createAuthRedirectUrl(),
      },
    });
    if (result?.error) {
      throw new CommentDataError([result.error.message || "Unable to send the sign-in link."]);
    }

    this.state = {
      ...createGuestIdentityState(true),
      notice: "Check your email for a sign-in link.",
    };
    this.notify();
    return this.state;
  }

  async signOut() {
    if (this.client) {
      const result = await this.client.auth.signOut();
      if (result?.error) {
        throw new CommentDataError([result.error.message || "Unable to sign out."]);
      }
    }
    this.setSession(null);
    return this.state;
  }

  async getAccessToken() {
    if (!this.state.signedIn) return "";
    if (!this.client) {
      throw new CommentDataError(["Your sign-in session is unavailable. Sign out or sign in again."]);
    }

    const result = await this.client.auth.getSession();
    if (result?.error) {
      throw new CommentDataError(["Your sign-in session expired. Sign out or sign in again."]);
    }
    const session = result?.data?.session ?? null;
    if (!session || typeof session.access_token !== "string" || !session.access_token) {
      this.setSession(null);
      throw new CommentDataError(["Your sign-in session expired. Sign in again or continue as a guest."]);
    }
    this.setSession(session);
    return session.access_token;
  }

  setSession(session) {
    const user = session?.user;
    if (!user || user.is_anonymous === true || typeof session.access_token !== "string") {
      this.state = createGuestIdentityState(true);
      this.notify();
      return;
    }

    const email = normalizeAuthEmail(user.email) || "";
    this.state = {
      available: true,
      provider: "supabase",
      signedIn: true,
      email,
      displayName: normalizeAuthDisplayName(user, email),
      notice: email ? "" : "This account does not provide an email address required for comments.",
    };
    this.notify();
  }

  notify() {
    if (typeof this.onChange === "function") {
      this.onChange({ ...this.state });
    }
  }
}

function createGuestIdentityState(available) {
  return {
    available: Boolean(available),
    provider: available ? "supabase" : "",
    signedIn: false,
    email: "",
    displayName: "",
    notice: "",
  };
}

function normalizeAuthEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : "";
}

function normalizeAuthDisplayName(user, email) {
  const metadata = user && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const candidates = [metadata.full_name, metadata.name, metadata.user_name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 80);
    }
  }
  return email ? email.split("@")[0].slice(0, 80) : "";
}

function createAuthRedirectUrl() {
  const url = new URL(window.location.href || window.location.origin);
  url.hash = "";
  return url.toString();
}

function createCommentData(config = {}) {
  const provider = String(config.provider || "").trim();
  if (provider !== "wordpress" && provider !== "zeropress") {
    throw new CommentDataError(["The comment provider is invalid."]);
  }

  const targetType = String(config.targetType || "").trim();
  if (targetType !== "post" && targetType !== "page") {
    throw new CommentDataError(["The comment target type is invalid."]);
  }

  const targetPublicId = parsePositiveInteger(String(config.targetPublicId || ""));
  if (!targetPublicId) {
    throw new CommentDataError(["The comment target identifier is invalid."]);
  }

  const apiBaseUrl = normalizeCommentApiBaseUrl(config.apiBaseUrl);
  if (!apiBaseUrl) {
    throw new CommentDataError(["The comment API base URL is invalid."]);
  }

  const requestToken = String(config.requestToken || "");
  const normalizedConfig = {
    ...config,
    provider,
    targetType,
    targetPublicId,
    apiBaseUrl,
    requestToken,
  };

  if (provider === "wordpress") {
    return new WordPressCommentData(normalizedConfig);
  }

  if (!normalizedConfig.requestToken.trim()) {
    throw new CommentDataError(["The comment request token is missing."]);
  }
  return new ZeroPressCommentData(normalizedConfig);
}

function getCommentDataErrorMessages(error) {
  if (error instanceof CommentDataError) {
    return error.messages.slice();
  }
  if (Array.isArray(error?.messages) && error.messages.length > 0) {
    return error.messages.map(normalizeCommentErrorMessage);
  }
  return [normalizeCommentErrorMessage(error?.message || error)];
}

function normalizeCommentErrorMessage(error) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const field = typeof error.field === "string" ? error.field.trim() : "";
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (field && message) return `${field}: ${message}`;
    if (message) return message;
  }
  return "Something went wrong. Please try again.";
}

function createCommentDataError(payload, fallbackMessage = "Something went wrong. Please try again.") {
  const errorPayload = unwrapZeroPressApiError(payload);
  if (Array.isArray(errorPayload?.errors) && errorPayload.errors.length > 0) {
    return new CommentDataError(errorPayload.errors);
  }
  if (errorPayload?.message) {
    return new CommentDataError([errorPayload.message]);
  }
  return new CommentDataError([fallbackMessage]);
}

async function fetchJson(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers || {}) },
    });
  } catch {
    throw new CommentDataError([
      "Unable to load comments. Check your network connection and try again.",
    ]);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: response.ok, payload };
}

function unwrapZeroPressApiData(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    payload.success === true &&
    payload.data &&
    typeof payload.data === "object"
  ) {
    return payload.data;
  }
  return payload;
}

function unwrapZeroPressApiItem(payload) {
  const data = unwrapZeroPressApiData(payload);
  if (data && typeof data === "object" && data.item && typeof data.item === "object") {
    return data.item;
  }
  return data;
}

function unwrapZeroPressApiError(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    payload.success === false &&
    payload.error &&
    typeof payload.error === "object"
  ) {
    return payload.error;
  }
  return payload;
}

function normalizeZeroPressCommentsPayload(payload, fallbackPage) {
  const data = unwrapZeroPressApiData(payload);
  const rawComments = Array.isArray(data?.items) ? data.items : null;
  if (!rawComments || !data.pagination || typeof data.pagination !== "object") {
    return null;
  }

  const comments = normalizeZeroPressComments(rawComments);
  if (!comments) return null;
  const currentPage = parsePositiveInteger(String(data.pagination.page || "")) || fallbackPage;
  const totalPages = parsePositiveInteger(String(data.pagination.total_pages || "")) || currentPage;
  const totalComments = Number.isInteger(Number(data.pagination.total_comments)) &&
    Number(data.pagination.total_comments) >= 0
    ? Number(data.pagination.total_comments)
    : comments.length;
  return {
    comments,
    pagination: { currentPage, totalPages, totalComments },
  };
}

function normalizeWordPressComments(comments) {
  return comments.map(normalizeWordPressComment).filter(Boolean);
}

function normalizeWordPressComment(comment) {
  if (!comment || typeof comment !== "object") return null;
  const id = String(comment.id || "").trim();
  if (!id) return null;

  const parentNumber = Number(comment.parent);
  const parentId = Number.isInteger(parentNumber) && parentNumber > 0
    ? String(parentNumber)
    : "";
  const createdAt = normalizeCommentDate(comment.date_gmt || comment.date || "");

  let contentText = "";
  if (typeof comment.content_text === "string") {
    contentText = comment.content_text;
  } else if (typeof comment.content?.text === "string") {
    contentText = comment.content.text;
  } else if (typeof comment.content?.rendered === "string") {
    contentText = htmlToCommentText(comment.content.rendered);
  } else {
    contentText = String(comment.content || "");
  }

  return {
    id,
    parentId,
    authorName: String(comment.author_name || ""),
    authorKind: "guest",
    createdAt,
    contentText,
  };
}

function normalizeZeroPressComments(comments) {
  const normalized = [];
  for (const comment of comments) {
    const item = normalizeZeroPressComment(comment);
    if (!item) return null;
    normalized.push(item);
  }
  return normalized;
}

function normalizeZeroPressComment(comment) {
  if (!comment || typeof comment !== "object") return null;
  const id = String(comment.id || "").trim();
  if (!id || !parsePositiveInteger(id)) return null;

  let parentId = "";
  if (comment.parent_id !== null) {
    const parentNumber = parsePositiveInteger(String(comment.parent_id || ""));
    if (!parentNumber) return null;
    parentId = String(parentNumber);
  }

  if (typeof comment.author_name !== "string" || typeof comment.content_text !== "string") {
    return null;
  }
  const createdAt = normalizeCanonicalUtcSecondIso(comment.created_at_iso);
  if (!createdAt) return null;

  return {
    id,
    parentId,
    authorName: comment.author_name,
    authorKind: normalizeCommentAuthorKind(comment.author_kind),
    createdAt,
    contentText: comment.content_text,
  };
}

function normalizeCommentAuthorKind(value) {
  if (value === "site_user" || value === "authenticated_user") return value;
  return "guest";
}

function normalizeCommentDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) return `${normalized}Z`;
  return normalized;
}

function normalizeCanonicalUtcSecondIso(value) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(normalized)) return "";
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z") === normalized ? normalized : "";
}

function htmlToCommentText(html) {
  const normalized = String(html || "")
    .replace(/<br\b[^>]*\/?>[ \t]*(?:\r?\n)?/gi, "\n")
    .replace(/<\/p\s*>[ \t]*(?:\r?\n)?/gi, "\n\n");
  const doc = new DOMParser().parseFromString(normalized, "text/html");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function isWordPressCommentPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.id !== undefined &&
    payload.post !== undefined &&
    payload.content &&
    typeof payload.content === "object",
  );
}

function isZeroPressSubmissionPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload.publication === "published" || payload.publication === "pending_moderation"),
  );
}

function buildWordPressEndpoint(config, options = {}) {
  const perPage = normalizePositiveInteger(String(options.perPage || config.perPage || ""));
  const page = normalizePositiveInteger(String(options.page || ""));
  const orderby = String(options.orderby || "").trim();
  const order = normalizeCommentsOrder(config.order);
  try {
    const url = createCommentTargetUrl(config);
    if (perPage) url.searchParams.set("per_page", perPage);
    if (page) url.searchParams.set("page", page);
    if (orderby) url.searchParams.set("orderby", orderby);
    if (order) url.searchParams.set("order", order);
    url.searchParams.set("post", String(config.targetPublicId));
    return url.toString();
  } catch {
    throw new CommentDataError(["The comment API base URL is invalid."]);
  }
}

function normalizeCommentApiBaseUrl(value) {
  const input = String(value || "").trim();
  const normalized = input === "/" ? input : input.replace(/\/+$/, "");
  if (!normalized || normalized.includes("\\")) return "";
  if (normalized.startsWith("/")) {
    return normalized.startsWith("//") ? "" : normalized;
  }
  try {
    const url = new URL(normalized);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "";
    return normalized;
  } catch {
    return "";
  }
}

function createCommentTargetUrl(config) {
  const url = new URL(config.apiBaseUrl, window.location.origin);
  const basePath = url.pathname.replace(/\/+$/, "");
  if (config.provider === "wordpress") {
    url.pathname = `${basePath}/comments`;
  } else {
    const targetCollection = config.targetType === "page" ? "pages" : "posts";
    const targetPublicId = encodeURIComponent(String(config.targetPublicId));
    url.pathname = `${basePath}/${targetCollection}/${targetPublicId}/comments`;
  }
  url.search = "";
  url.hash = "";
  return url;
}

function buildZeroPressCommentsEndpoint(config, options = {}) {
  const {
    page = "",
    challenge = null,
    includeRequestToken = true,
    includeChallenge = true,
  } = options;
  try {
    const url = createCommentTargetUrl(config);
    const pageValue = normalizePositiveInteger(String(page));
    if (pageValue) url.searchParams.set("page", pageValue);
    if (includeRequestToken) url.searchParams.set("comment_request_token", config.requestToken);
    if (includeChallenge && challenge) {
      url.searchParams.set("comment_challenge_token", challenge.token);
      url.searchParams.set("comment_challenge_solution", challenge.solution);
    }
    return url.toString();
  } catch {
    throw new CommentDataError(["The comment API base URL is invalid."]);
  }
}

function buildZeroPressChallengeEndpoint(config, scope) {
  try {
    const url = createCommentTargetUrl(config);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/challenge/${encodeURIComponent(scope)}`;
    url.search = "";
    url.searchParams.set("comment_request_token", config.requestToken);
    return url.toString();
  } catch {
    throw new CommentDataError(["The comment API base URL is invalid."]);
  }
}

function buildZeroPressAuthDiscoveryEndpoint(config) {
  try {
    const url = new URL(config.apiBaseUrl, window.location.origin);
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/comments/auth`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new CommentDataError(["The comment API base URL is invalid."]);
  }
}

async function fetchCommentAuthDiscovery(config) {
  const response = await fetchJson(buildZeroPressAuthDiscoveryEndpoint(config));
  if (!response.ok) return null;
  const payload = unwrapZeroPressApiData(response.payload);
  if (!payload || payload.enabled !== true) return null;
  if (payload.provider !== "supabase" || payload.mode !== "optional") return null;

  const projectUrl = normalizeSupabaseProjectUrl(payload.project_url);
  const publishableKey = typeof payload.publishable_key === "string" &&
    SUPABASE_PUBLISHABLE_KEY_PATTERN.test(payload.publishable_key)
    ? payload.publishable_key
    : "";
  return projectUrl && publishableKey ? { projectUrl, publishableKey } : null;
}

function normalizeSupabaseProjectUrl(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return "";
  }

  try {
    const url = new URL(value);
    const isLoopback = url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null"
    ) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function normalizeChallengeSettings(challenge = {}) {
  return {
    read: {
      maxMs: parseBoundedInteger(challenge.read?.maxMs, COMMENT_CHALLENGE_DEFAULTS.read.maxMs, 250, 10000),
      retries: parseBoundedInteger(challenge.read?.retries, COMMENT_CHALLENGE_DEFAULTS.read.retries, 0, 5),
    },
    write: {
      maxMs: parseBoundedInteger(challenge.write?.maxMs, COMMENT_CHALLENGE_DEFAULTS.write.maxMs, 250, 10000),
      retries: parseBoundedInteger(challenge.write?.retries, COMMENT_CHALLENGE_DEFAULTS.write.retries, 0, 5),
    },
  };
}

async function fetchCommentChallenge(config, scope, maxMs) {
  let response;
  try {
    response = await fetchJson(buildZeroPressChallengeEndpoint(config, scope));
  } catch {
    return {
      challenge: null,
      message: "Unable to verify the comment request. Check your network connection and try again.",
      timedOut: false,
    };
  }
  const payload = unwrapZeroPressApiItem(response.payload);
  if (!response.ok) {
    return {
      challenge: null,
      message: unwrapZeroPressApiError(response.payload)?.message || "Comments are temporarily unavailable.",
      timedOut: false,
    };
  }
  if (
    !payload ||
    payload.algorithm !== "zp-comment-pow-v1" ||
    payload.scope !== scope ||
    typeof payload.challenge_token !== "string" ||
    typeof payload.difficulty !== "number" ||
    typeof payload.expires_at !== "string"
  ) {
    return { challenge: null, message: "Comments are temporarily unavailable.", timedOut: false };
  }

  const result = await solveCommentChallenge(payload.challenge_token, payload.difficulty, maxMs);
  if (!result.solution) {
    return {
      challenge: null,
      message: result.timedOut
        ? "Comment verification took too long. Try again."
        : "Comments are temporarily unavailable.",
      timedOut: result.timedOut,
    };
  }
  return {
    challenge: {
      token: payload.challenge_token,
      solution: result.solution,
      expiresAt: new Date(payload.expires_at),
    },
    message: "",
    timedOut: false,
  };
}

async function fetchCommentWriteVerification(config) {
  let response;
  try {
    response = await fetchJson(buildZeroPressChallengeEndpoint(config, "write"));
  } catch {
    return {
      descriptor: null,
      message: "Unable to verify the comment request. Check your network connection and try again.",
    };
  }

  const payload = unwrapZeroPressApiItem(response.payload);
  if (!response.ok) {
    return {
      descriptor: null,
      message: unwrapZeroPressApiError(response.payload)?.message || "Comments are temporarily unavailable.",
    };
  }

  const descriptor = normalizeWriteVerificationDescriptor(payload, "write", "comment_create", "zp-comment-pow-v1");
  return descriptor
    ? { descriptor, message: "" }
    : { descriptor: null, message: "Comment verification response was invalid." };
}

function normalizeWriteVerificationDescriptor(payload, scope, action, algorithm) {
  if (!payload || typeof payload !== "object" || payload.scope !== scope) return null;

  if (payload.mode === "pow") {
    const pow = payload.pow;
    if (
      !pow ||
      pow.algorithm !== algorithm ||
      pow.scope !== scope ||
      typeof pow.challenge_token !== "string" ||
      typeof pow.difficulty !== "number" ||
      typeof pow.expires_at !== "string"
    ) {
      return null;
    }
    return { mode: "pow", pow };
  }

  if (payload.mode === "turnstile") {
    const turnstile = payload.turnstile;
    if (
      !turnstile ||
      typeof turnstile.site_key !== "string" ||
      !turnstile.site_key ||
      turnstile.action !== action
    ) {
      return null;
    }
    return { mode: "turnstile", turnstile };
  }

  return null;
}

async function executeTurnstile(config, verificationTarget) {
  await loadTurnstileApi();
  if (!window.turnstile || typeof window.turnstile.render !== "function") {
    throw new Error("Turnstile verification is not available.");
  }

  const container = document.createElement("div");
  container.dataset.zpTurnstile = "";
  const host = verificationTarget && typeof verificationTarget.appendChild === "function"
    ? verificationTarget
    : document.body;
  host.appendChild(container);

  return new Promise((resolve, reject) => {
    let settled = false;
    let widgetId;
    const timeout = setTimeout(() => finish(null, "Turnstile verification timed out. Try again."), TURNSTILE_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      if (widgetId !== undefined && typeof window.turnstile.remove === "function") {
        window.turnstile.remove(widgetId);
      }
      container.remove();
    }

    function finish(token, message) {
      if (settled) return;
      settled = true;
      cleanup();
      if (token) resolve(token);
      else reject(new Error(message || "Turnstile verification failed. Try again."));
    }

    try {
      widgetId = window.turnstile.render(container, {
        sitekey: config.site_key,
        action: config.action,
        appearance: "interaction-only",
        execution: "execute",
        "feedback-enabled": false,
        callback: (token) => finish(String(token || ""), ""),
        "error-callback": () => finish(null, "Turnstile verification failed. Try again."),
        "expired-callback": () => finish(null, "Turnstile verification expired. Try again."),
        "timeout-callback": () => finish(null, "Turnstile verification timed out. Try again."),
      });
      window.turnstile.execute(widgetId);
    } catch {
      finish(null, "Turnstile verification is not available.");
    }
  });
}

function loadTurnstileApi() {
  if (window.turnstile && typeof window.turnstile.render === "function") {
    return Promise.resolve();
  }
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    const script = existing || document.createElement("script");
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Turnstile verification timed out. Try again.")),
      TURNSTILE_TIMEOUT_MS,
    );

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        turnstileScriptPromise = null;
        script.remove();
        reject(error);
        return;
      }
      resolve();
    }

    script.addEventListener("load", () => finish(null), { once: true });
    script.addEventListener("error", () => {
      finish(new Error("Turnstile verification is not available."));
    }, { once: true });
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return turnstileScriptPromise;
}

function loadSupabaseApi() {
  if (window.supabase && typeof window.supabase.createClient === "function") {
    return Promise.resolve();
  }
  if (supabaseScriptPromise) return supabaseScriptPromise;

  supabaseScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SUPABASE_SCRIPT_URL}"]`);
    const script = existing || document.createElement("script");
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Supabase Auth loading timed out.")),
      SUPABASE_SCRIPT_TIMEOUT_MS,
    );

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error || !window.supabase || typeof window.supabase.createClient !== "function") {
        supabaseScriptPromise = null;
        if (!existing) script.remove();
        reject(error || new Error("Supabase Auth is unavailable."));
        return;
      }
      resolve();
    }

    script.addEventListener("load", () => finish(null), { once: true });
    script.addEventListener("error", () => finish(new Error("Supabase Auth is unavailable.")), { once: true });
    if (!existing) {
      script.src = SUPABASE_SCRIPT_URL;
      script.integrity = SUPABASE_SCRIPT_INTEGRITY;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return supabaseScriptPromise;
}

function isCommentChallengeError(payload) {
  const error = unwrapZeroPressApiError(payload);
  return Boolean(error && COMMENT_CHALLENGE_ERROR_CODES.has(String(error.code || "")));
}

function hasFreshCommentChallenge(challenge) {
  return Boolean(
    challenge?.token &&
    challenge?.solution &&
    challenge.expiresAt instanceof Date &&
    challenge.expiresAt.getTime() - Date.now() > 10000,
  );
}

function parsePositiveInteger(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) return 0;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizePositiveInteger(value) {
  const parsed = parsePositiveInteger(value);
  return parsed ? String(parsed) : "";
}

function parseBoundedInteger(value, fallback, min, max) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeCommentsOrder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "asc" || normalized === "desc" ? normalized : "";
}

function nowMs() {
  return window.performance?.now?.() ?? Date.now();
}

async function solveCommentChallenge(challengeToken, difficulty, maxMs) {
  const normalizedDifficulty = Number.isInteger(difficulty)
    ? Math.min(24, Math.max(0, difficulty))
    : 0;
  const startedAt = nowMs();
  for (let counter = 0; counter <= Number.MAX_SAFE_INTEGER; counter += 1) {
    if (counter > 0 && counter % 250 === 0 && nowMs() - startedAt > maxMs) {
      return { solution: "", timedOut: true };
    }
    const solution = String(counter);
    if (hasLeadingZeroBits(sha256Bytes(`${challengeToken}.${solution}`), normalizedDifficulty)) {
      return { solution, timedOut: false };
    }
    if (counter > 0 && counter % 1000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { solution: "", timedOut: false };
}

function hasLeadingZeroBits(bytes, bitCount) {
  let remaining = bitCount;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    if (remaining >= 8) {
      if (byte !== 0) return false;
      remaining -= 8;
      continue;
    }
    const mask = (0xff << (8 - remaining)) & 0xff;
    return (byte & mask) === 0;
  }
  return remaining <= 0;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Bytes(message) {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const blockCount = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => outputView.setUint32(index * 4, word));
  return output;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

window.ZeroPressCommentData = Object.freeze({
  create: createCommentData,
  getErrorMessages: getCommentDataErrorMessages,
});
})();
