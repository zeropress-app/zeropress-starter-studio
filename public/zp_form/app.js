(function () {
  "use strict";

  var FORM_ENDPOINT = "";
  var configUrl = new URL("./config.json", document.currentScript.src);
  var FORM_CHALLENGE_MAX_MS = 3000;
  var FORM_CHALLENGE_RETRIES = 5;
  var TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var TURNSTILE_TIMEOUT_MS = 120000;
  var turnstileScriptPromise = null;
  var form = document.querySelector("[data-form]");
  var title = document.querySelector("[data-form-title]");
  var description = document.querySelector("[data-form-description]");
  var fieldRoot = document.querySelector("[data-form-fields]");
  var submitButton = document.querySelector("[data-form-submit]");
  var message = document.querySelector("[data-form-message]");
  var controls = document.querySelector("[data-form-controls]");
  var retryButton = document.querySelector("[data-form-retry]");
  var ready = false;
  var loading = false;
  var submitting = false;
  var fieldSignature = null;
  var activeFields = [];

  if (!form || !fieldRoot || !submitButton || !message || !controls || !retryButton) {
    return;
  }

  async function loadEndpoint() {
    var config;
    try {
      var response = await fetch(configUrl, {
        headers: { accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Configuration unavailable.");
      config = await response.json();
    } catch {
      setMessage("error", "Could not load config.json. Check the file and reload.");
      return "";
    }

    if (!config || Array.isArray(config) || typeof config.form_endpoint !== "string") {
      setMessage("error", "Set a valid form_endpoint in config.json.");
      return "";
    }
    var endpoint = config.form_endpoint.trim();
    if (!endpoint) {
      setMessage("setup", "Set form_endpoint in config.json to enable this form.");
      return "";
    }
    try {
      var url = new URL(endpoint);
      if ((url.protocol !== "https:" && url.protocol !== "http:") ||
          url.username || url.password || url.search || url.hash) {
        throw new Error("Invalid endpoint.");
      }
      return url.href.replace(/\/+$/, "");
    } catch {
      setMessage("error", "Set a valid form_endpoint in config.json.");
      return "";
    }
  }

  function syncControls() {
    controls.disabled = !ready || loading || submitting;
    submitButton.disabled = controls.disabled;
    retryButton.hidden = ready || loading || submitting;
    form.setAttribute("aria-busy", String(loading || submitting));
  }

  function requestError(response, payload, fallback) {
    var text = getErrorMessage(payload, fallback);
    var unavailable = response.status === 404 || response.status === 503;
    if (response.status === 404) text = "This form is not accepting submissions.";
    if (response.status === 503) text = "This form is temporarily unavailable. Please try again later.";
    if (response.status === 429) text = "Too many requests. Please try again later.";
    var error = new Error(text);
    error.unavailable = unavailable;
    error.status = response.status;
    return error;
  }

  function setMessage(state, text) {
    message.dataset.state = state;
    message.textContent = text;
  }

  function clearMessage() {
    delete message.dataset.state;
    message.textContent = "";
  }

  function normalizeOptions(options) {
    return Array.isArray(options) ? options : [];
  }

  function createFieldLabel(field, inputId) {
    var label = document.createElement("label");
    label.setAttribute("for", inputId);
    label.textContent = field.label || field.key;
    return label;
  }

  function appendHelpText(wrapper, field) {
    if (!field.help_text) return;
    var help = document.createElement("p");
    help.className = "help-text";
    help.textContent = field.help_text;
    wrapper.appendChild(help);
  }

  function createTextField(field, type) {
    var wrapper = document.createElement("div");
    var inputId = "form-field-" + field.key;
    var input = document.createElement(type === "textarea" ? "textarea" : "input");
    wrapper.className = "field";
    input.id = inputId;
    input.name = field.key;
    input.dataset.formField = field.key;
    if (type !== "textarea") input.type = type;
    if (field.required) input.required = true;
    if (field.placeholder) input.placeholder = field.placeholder;
    wrapper.appendChild(createFieldLabel(field, inputId));
    wrapper.appendChild(input);
    appendHelpText(wrapper, field);
    return wrapper;
  }

  function createSelectField(field) {
    var wrapper = document.createElement("div");
    var inputId = "form-field-" + field.key;
    var select = document.createElement("select");
    var emptyOption = document.createElement("option");
    wrapper.className = "field";
    select.id = inputId;
    select.name = field.key;
    select.dataset.formField = field.key;
    if (field.required) select.required = true;
    emptyOption.value = "";
    emptyOption.textContent = "Select...";
    select.appendChild(emptyOption);
    normalizeOptions(field.options).forEach(function (option) {
      var element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label || option.value;
      select.appendChild(element);
    });
    wrapper.appendChild(createFieldLabel(field, inputId));
    wrapper.appendChild(select);
    appendHelpText(wrapper, field);
    return wrapper;
  }

  function createChoiceField(field, multiple) {
    var fieldset = document.createElement("fieldset");
    var legend = document.createElement("legend");
    var list = document.createElement("div");
    fieldset.className = "choice-field";
    legend.textContent = field.label || field.key;
    list.className = "choice-list";
    normalizeOptions(field.options).forEach(function (option, index) {
      var id = "form-field-" + field.key + "-" + index;
      var label = document.createElement("label");
      var input = document.createElement("input");
      var text = document.createElement("span");
      label.className = "choice";
      input.id = id;
      input.type = multiple ? "checkbox" : "radio";
      input.name = field.key;
      input.value = option.value;
      input.dataset.formField = field.key;
      if (!multiple && field.required) input.required = true;
      text.textContent = option.label || option.value;
      label.appendChild(input);
      label.appendChild(text);
      list.appendChild(label);
    });
    fieldset.appendChild(legend);
    fieldset.appendChild(list);
    appendHelpText(fieldset, field);
    return fieldset;
  }

  function createField(field) {
    if (field.type === "textarea") return createTextField(field, "textarea");
    if (field.type === "email") return createTextField(field, "email");
    if (field.type === "number") return createTextField(field, "number");
    if (field.type === "date") return createTextField(field, "date");
    if (field.type === "phone") return createTextField(field, "tel");
    if (field.type === "select") return createSelectField(field);
    if (field.type === "radio") return createChoiceField(field, false);
    if (field.type === "checkbox") return createChoiceField(field, true);
    return createTextField(field, "text");
  }

  function renderFields(fields) {
    var nextFields = Array.isArray(fields) ? fields : [];
    var nextSignature = JSON.stringify(nextFields);
    if (fieldSignature === nextSignature) return;
    fieldRoot.replaceChildren();
    activeFields = nextFields;
    activeFields.forEach(function (field) {
      fieldRoot.appendChild(createField(field));
    });
    fieldSignature = nextSignature;
  }

  function getFieldValue(field) {
    if (field.type === "checkbox") {
      return Array.from(form.querySelectorAll('[name="' + cssEscape(field.key) + '"]:checked'))
        .map(function (input) { return input.value; });
    }

    var input = form.querySelector('[name="' + cssEscape(field.key) + '"]');
    if (!input) return null;
    return input.value;
  }

  function collectFields() {
    var values = {};
    activeFields.forEach(function (field) {
      var value = getFieldValue(field);
      if (Array.isArray(value)) {
        if (value.length > 0) values[field.key] = value;
        return;
      }
      if (typeof value === "string" && value.trim() !== "") {
        values[field.key] = value;
      }
    });
    return values;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function unwrapApiData(payload) {
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

  function unwrapApiItem(payload) {
    var data = unwrapApiData(payload);
    if (data && typeof data === "object" && data.item && typeof data.item === "object") {
      return data.item;
    }
    return data;
  }

  function unwrapApiError(payload) {
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

  function getErrorMessage(payload, fallback) {
    var errorPayload = unwrapApiError(payload);
    if (errorPayload && typeof errorPayload.message === "string" && errorPayload.message) {
      return errorPayload.message;
    }
    if (errorPayload && Array.isArray(errorPayload.errors) && errorPayload.errors.length > 0) {
      return errorPayload.errors
        .map(function (item) {
          return item && typeof item.message === "string" ? item.message : "";
        })
        .filter(Boolean)
        .join(" ");
    }
    return fallback;
  }

  function isFormChallengeError(payload) {
    var errorPayload = unwrapApiError(payload);
    return errorPayload &&
      typeof errorPayload === "object" &&
      [
        "MISSING_FORM_CHALLENGE",
        "INVALID_FORM_CHALLENGE",
        "EXPIRED_FORM_CHALLENGE",
        "FORM_CHALLENGE_ALREADY_USED",
        "INVALID_TURNSTILE_TOKEN",
      ].indexOf(String(errorPayload.code || "")) !== -1;
  }

  function getFormChallengeEndpoint() {
    return FORM_ENDPOINT.replace(/\/$/, "") + "/challenge/submit";
  }

  function nowMs() {
    return window.performance && typeof window.performance.now === "function"
      ? window.performance.now()
      : Date.now();
  }

  function hasLeadingZeroBits(bytes, bitCount) {
    var remaining = bitCount;
    for (var index = 0; index < bytes.length; index += 1) {
      var byte = bytes[index];
      if (remaining <= 0) return true;
      if (remaining >= 8) {
        if (byte !== 0) return false;
        remaining -= 8;
        continue;
      }

      var mask = (0xff << (8 - remaining)) & 0xff;
      return (byte & mask) === 0;
    }

    return remaining <= 0;
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Bytes(message) {
    if (typeof TextEncoder !== "function") {
      throw new Error("Form verification is not available in this browser.");
    }

    var bytes = new TextEncoder().encode(message);
    var bitLength = bytes.length * 8;
    var blockCount = Math.ceil((bytes.length + 9) / 64);
    var padded = new Uint8Array(blockCount * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    var view = new DataView(padded.buffer);
    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength >>> 0;
    view.setUint32(padded.length - 8, high);
    view.setUint32(padded.length - 4, low);

    var h0 = 0x6a09e667;
    var h1 = 0xbb67ae85;
    var h2 = 0x3c6ef372;
    var h3 = 0xa54ff53a;
    var h4 = 0x510e527f;
    var h5 = 0x9b05688c;
    var h6 = 0x1f83d9ab;
    var h7 = 0x5be0cd19;
    var words = new Uint32Array(64);

    for (var offset = 0; offset < padded.length; offset += 64) {
      var index;
      for (index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4);
      }
      for (index = 16; index < 64; index += 1) {
        var s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        var s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }

      var a = h0;
      var b = h1;
      var c = h2;
      var d = h3;
      var e = h4;
      var f = h5;
      var g = h6;
      var h = h7;

      for (index = 0; index < 64; index += 1) {
        var roundS1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + roundS1 + ch + SHA256_K[index] + words[index]) >>> 0;
        var roundS0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (roundS0 + maj) >>> 0;

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

    var output = new Uint8Array(32);
    var outputView = new DataView(output.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (word, index) {
      outputView.setUint32(index * 4, word);
    });
    return output;
  }

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  async function solveFormChallenge(challengeToken, difficulty, maxMs) {
    var normalizedDifficulty = Number.isInteger(difficulty)
      ? Math.min(24, Math.max(0, difficulty))
      : 0;
    var startedAt = nowMs();

    for (var counter = 0; counter <= Number.MAX_SAFE_INTEGER; counter += 1) {
      if (counter > 0 && counter % 250 === 0 && nowMs() - startedAt > maxMs) {
        return { solution: "", timedOut: true };
      }

      var solution = String(counter);
      var digest = sha256Bytes(challengeToken + "." + solution);
      if (hasLeadingZeroBits(digest, normalizedDifficulty)) {
        return { solution: solution, timedOut: false };
      }

      if (counter > 0 && counter % 250 === 0) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 0);
        });
      }
    }

    return { solution: "", timedOut: false };
  }

  async function fetchFormVerification() {
    var response = await fetch(getFormChallengeEndpoint(), {
      headers: { accept: "application/json" },
    });
    var payload = await response.json().catch(function () { return {}; });
    var verification = unwrapApiItem(payload);

    if (!response.ok) {
      throw requestError(response, payload, "Form verification could not be started.");
    }

    if (
      !verification ||
      verification.scope !== "submit" ||
      (verification.mode !== "pow" && verification.mode !== "turnstile")
    ) {
      throw new Error("Form verification response was invalid.");
    }

    if (verification.mode === "pow") {
      if (
        !verification.pow ||
        verification.pow.algorithm !== "zp-form-pow-v1" ||
        verification.pow.scope !== "submit" ||
        typeof verification.pow.challenge_token !== "string" ||
        typeof verification.pow.difficulty !== "number"
      ) {
        throw new Error("Form verification response was invalid.");
      }
      return { mode: "pow", pow: verification.pow };
    }

    if (
      !verification.turnstile ||
      typeof verification.turnstile.site_key !== "string" ||
      !verification.turnstile.site_key ||
      verification.turnstile.action !== "form_submit"
    ) {
      throw new Error("Form verification response was invalid.");
    }
    return { mode: "turnstile", turnstile: verification.turnstile };
  }

  async function getFormWriteVerification() {
    var lastMessage = "Form verification took too long. Try again.";
    for (var attempt = 0; attempt < FORM_CHALLENGE_RETRIES; attempt += 1) {
      var verification = await fetchFormVerification();
      if (verification.mode === "turnstile") {
        return {
          turnstile_token: await executeTurnstile(verification.turnstile),
        };
      }

      var result = await solveFormChallenge(
        verification.pow.challenge_token,
        verification.pow.difficulty,
        FORM_CHALLENGE_MAX_MS,
      );

      if (result.solution) {
        return {
          form_challenge_token: verification.pow.challenge_token,
          form_challenge_solution: result.solution,
        };
      }

      lastMessage = result.timedOut
        ? "Form verification took too long. Try again."
        : "Form verification failed. Try again.";
    }

    throw new Error(lastMessage);
  }

  async function executeTurnstile(config) {
    await loadTurnstileApi();
    if (!window.turnstile || typeof window.turnstile.render !== "function") {
      throw new Error("Turnstile verification is not available.");
    }

    var container = document.createElement("div");
    container.dataset.zpTurnstile = "";
    document.body.appendChild(container);

    return new Promise(function (resolve, reject) {
      var settled = false;
      var widgetId;
      var timeout = setTimeout(function () {
        finish(null, "Turnstile verification timed out. Try again.");
      }, TURNSTILE_TIMEOUT_MS);

      function cleanup() {
        clearTimeout(timeout);
        if (widgetId !== undefined && typeof window.turnstile.remove === "function") {
          window.turnstile.remove(widgetId);
        }
        container.remove();
      }

      function finish(token, text) {
        if (settled) return;
        settled = true;
        cleanup();
        if (token) resolve(token);
        else reject(new Error(text || "Turnstile verification failed. Try again."));
      }

      try {
        widgetId = window.turnstile.render(container, {
          sitekey: config.site_key,
          action: config.action,
          appearance: "interaction-only",
          execution: "execute",
          "feedback-enabled": false,
          callback: function (token) { finish(String(token || ""), ""); },
          "error-callback": function () { finish(null, "Turnstile verification failed. Try again."); },
          "expired-callback": function () { finish(null, "Turnstile verification expired. Try again."); },
          "timeout-callback": function () { finish(null, "Turnstile verification timed out. Try again."); },
        });
        window.turnstile.execute(widgetId);
      } catch (_error) {
        finish(null, "Turnstile verification is not available.");
      }
    });
  }

  function loadTurnstileApi() {
    if (window.turnstile && typeof window.turnstile.render === "function") {
      return Promise.resolve();
    }
    if (turnstileScriptPromise) return turnstileScriptPromise;

    turnstileScriptPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + TURNSTILE_SCRIPT_URL + '"]');
      var script = existing || document.createElement("script");
      var settled = false;
      var timeout = setTimeout(function () {
        finish(new Error("Turnstile verification timed out. Try again."));
      }, TURNSTILE_TIMEOUT_MS);

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

      script.addEventListener("load", function () { finish(null); }, { once: true });
      script.addEventListener("error", function () {
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

  function loadForm() {
    if (!FORM_ENDPOINT || loading || submitting) return;
    ready = false;
    loading = true;
    setMessage("loading", "Checking availability...");
    syncControls();
    fetch(FORM_ENDPOINT, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    })
      .then(async function (response) {
        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          throw requestError(response, payload, "Could not check form availability. Please try again.");
        }
        return payload;
      })
      .then(function (payload) {
        var item = unwrapApiItem(payload);
        if (!item || !item.form || typeof item.form !== "object" || !Array.isArray(item.fields)) {
          throw new Error("Could not check form availability. Please try again.");
        }
        if (title && item.form.title) title.textContent = item.form.title;
        if (description && item.form.description) description.textContent = item.form.description;
        if (item.form.submit_label) submitButton.textContent = item.form.submit_label;
        renderFields(item.fields);
        ready = true;
        clearMessage();
      })
      .catch(function (error) {
        var text = error && (error.unavailable || error.status === 429)
          ? error.message
          : "Could not check form availability. Please try again.";
        setMessage("error", text);
      })
      .finally(function () {
        loading = false;
        syncControls();
      });
  }

  retryButton.addEventListener("click", loadForm);

  async function submitForm() {
    var verification = await getFormWriteVerification();
    var payload = {
      fields: collectFields(),
      source_url: window.location.href,
    };
    Object.keys(verification).forEach(function (key) {
      payload[key] = verification[key];
    });
    var response = await fetch(FORM_ENDPOINT + "/submissions", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    var body = await response.json().catch(function () { return {}; });
    return {
      response: response,
      body: body,
    };
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!ready || loading || submitting) return;
    submitting = true;
    clearMessage();
    syncControls();

    submitForm()
      .then(function (result) {
        if (!result.response.ok && isFormChallengeError(result.body)) {
          return submitForm();
        }
        return result;
      })
      .then(function (result) {
        if (!result.response.ok) {
          throw requestError(result.response, result.body, "Form submission failed.");
        }
        return unwrapApiData(result.body);
      })
      .then(function (body) {
        form.reset();
        setMessage("success", body && body.message ? body.message : "Your response has been received.");
      })
      .catch(function (error) {
        if (error && error.unavailable) ready = false;
        setMessage("error", error && error.message ? error.message : "Form submission failed.");
      })
      .finally(function () {
        submitting = false;
        syncControls();
      });
  });

  async function initialize() {
    FORM_ENDPOINT = await loadEndpoint();
    form.setAttribute("aria-busy", "false");
    if (FORM_ENDPOINT) loadForm();
  }

  initialize();
})();
