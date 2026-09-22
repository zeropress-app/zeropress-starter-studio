(() => {
"use strict";

function createDateFormatter(options) {
  if (!window.Intl || !Intl.DateTimeFormat) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat(undefined, options);
  } catch {
    return null;
  }
}

const localDateTimeFormatter = createDateFormatter({
  dateStyle: "medium",
  timeStyle: "short",
});

function enhanceTimeElement(time, formatter) {
  if (!(time instanceof HTMLTimeElement) || !formatter) {
    return;
  }

  const value = time.getAttribute("datetime");
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return;
  }

  if (!time.getAttribute("title")) {
    time.setAttribute("title", value);
  }
  time.textContent = formatter.format(date);
}

function parsePositiveInteger(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return 0;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 0;
  }

  const parsed = Number.parseInt(normalizedValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function parseCommentTargetPublicId(element) {
  if (!(element instanceof HTMLElement)) {
    return 0;
  }

  return parsePositiveInteger(element.dataset.zpCommentsTargetPublicId || "");
}

function getCommentSortTime(comment) {
  const time = new Date(String(comment.createdAt || "")).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareCommentIds(left, right) {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(left.id || "").localeCompare(String(right.id || ""));
}

function compareCommentsForDisplay(left, right, order = "asc") {
  const timeDiff = getCommentSortTime(left) - getCommentSortTime(right);
  if (timeDiff !== 0) {
    return order === "desc" ? -timeDiff : timeDiff;
  }

  return compareCommentIds(left, right);
}

function sortCommentNodeChildren(node) {
  node.children.sort((left, right) => compareCommentsForDisplay(left, right, "asc"));
  node.children.forEach(sortCommentNodeChildren);
}

function buildCommentTree(comments, rootOrder = "asc") {
  const map = new Map();
  const roots = [];

  comments.forEach((comment) => {
    const commentId = String(comment.id || "");
    if (!commentId) {
      return;
    }

    map.set(commentId, {
      ...comment,
      children: [],
    });
  });

  comments.forEach((comment) => {
    const commentId = String(comment.id || "");
    const node = map.get(commentId);
    if (!node) {
      return;
    }

    const parentId = String(comment.parentId || "");

    if (parentId && map.has(parentId)) {
      map.get(parentId).children.push(node);
      return;
    }

    roots.push(node);
  });

  roots.sort((left, right) => compareCommentsForDisplay(left, right, rootOrder));
  roots.forEach(sortCommentNodeChildren);
  return roots;
}

function cloneCommentNodeForDisplay(node) {
  const { children, ...comment } = node;
  return {
    ...comment,
    children: [],
  };
}

function flattenCommentNode(node, target) {
  const displayNode = cloneCommentNodeForDisplay(node);
  target.push(displayNode);

  if (Array.isArray(node.children)) {
    node.children.forEach((childNode) => {
      flattenCommentNode(childNode, target);
    });
  }
}

function appendThreadedCommentNode(node, depth, target, maxDepth) {
  const displayNode = cloneCommentNodeForDisplay(node);
  target.push(displayNode);

  if (!Array.isArray(node.children) || node.children.length === 0) {
    return;
  }

  if (depth < maxDepth - 1) {
    node.children.forEach((childNode) => {
      appendThreadedCommentNode(childNode, depth + 1, displayNode.children, maxDepth);
    });
    return;
  }

  node.children.forEach((childNode) => {
    flattenCommentNode(childNode, target);
  });
}

function buildCommentDisplayTree(comments, settings) {
  if (!settings.threadComments) {
    return comments
      .slice()
      .sort((left, right) => compareCommentsForDisplay(left, right, settings.order))
      .map((comment) => ({
        ...comment,
        children: [],
      }));
  }

  const roots = [];
  buildCommentTree(comments, settings.order).forEach((rootNode) => {
    appendThreadedCommentNode(rootNode, 0, roots, settings.threadDepth);
  });
  return roots;
}

function reportCommentsContractError(message, details = "") {
  console.error("[ZeroPress Comments]", message, details);
}

function getCommentInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return "";
  }

  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function getCommentTemplate(scope, attribute, label) {
  const template = scope.querySelector(`template[${attribute}]`);
  if (!(template instanceof HTMLTemplateElement)) {
    reportCommentsContractError(`Missing required ${label} template.`, attribute);
    return null;
  }

  return template;
}

function resolveCommentsTemplates(mount) {
  const scope = mount.closest(".comments-block");
  if (!(scope instanceof HTMLElement)) {
    reportCommentsContractError("Comments mount is missing a .comments-block scope.");
    return null;
  }

  const shell = getCommentTemplate(scope, "data-zp-comments-shell", "comments shell");
  const form = getCommentTemplate(scope, "data-zp-comments-form", "comments form");
  const replyForm = getCommentTemplate(scope, "data-zp-comment-reply-form", "comment reply form");
  const item = getCommentTemplate(scope, "data-zp-comment-item", "comment item");
  const empty = getCommentTemplate(scope, "data-zp-comments-empty", "comments empty state");
  const error = getCommentTemplate(scope, "data-zp-comment-error", "comment error state");
  const success = getCommentTemplate(scope, "data-zp-comment-success", "comment success state");

  if (!shell || !form || !replyForm || !item || !empty || !error || !success) {
    return null;
  }

  return { shell, form, replyForm, item, empty, error, success };
}

function cloneTemplateFragment(template) {
  return template.content.cloneNode(true);
}

function getCommentRole(container, role) {
  const target = container.querySelector(`[data-role="${role}"]`);
  return target instanceof HTMLElement ? target : null;
}

function getRequiredCommentRole(container, role, contextLabel) {
  const target = getCommentRole(container, role);
  if (!target) {
    reportCommentsContractError(`Missing required ${role} role in ${contextLabel}.`);
    return null;
  }

  return target;
}

function validateCommentFormFragment(fragment, options = {}) {
  const { parentId = "", values = null } = options;
  const form = fragment.querySelector("[data-zp-comment-form]");
  if (!(form instanceof HTMLFormElement)) {
    reportCommentsContractError("Comments form template must contain <form data-zp-comment-form>.");
    return null;
  }

  const requiredFieldNames = [
    "author_name",
    "author_email",
    "content",
    "parent",
    "website",
  ];

  for (const name of requiredFieldNames) {
    const field = form.querySelector(`[name="${name}"]`);
    if (!(field instanceof HTMLElement)) {
      reportCommentsContractError(`Comments form template is missing required field: ${name}.`);
      return null;
    }
  }

  const parentIdField = form.querySelector('[name="parent"]');
  if (parentIdField instanceof HTMLInputElement) {
    parentIdField.value = String(values?.parent ?? parentId);
  }

  ["author_name", "author_email", "content"].forEach((name) => {
    const value = values?.[name];
    if (typeof value !== "string") {
      return;
    }

    const field = form.querySelector(`[name="${name}"]`);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = value;
    }
  });

  const websiteField = form.querySelector('[name="website"]');
  if (websiteField instanceof HTMLInputElement) {
    websiteField.value = "";
  }

  return form;
}

function normalizeCommentErrorMessage(error) {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const field = typeof error.field === "string" ? error.field.trim() : "";
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (field && message) {
      return `${field}: ${message}`;
    }

    return message || "Something went wrong. Please try again.";
  }

  return String(error || "Something went wrong. Please try again.");
}

function createCommentFeedbackFragment(templates, errors, successMessage) {
  const fragment = document.createDocumentFragment();

  if (Array.isArray(errors) && errors.length > 0) {
    errors.map(normalizeCommentErrorMessage).forEach((errorMessage) => {
      const errorFragment = cloneTemplateFragment(templates.error);
      const messageTarget = getRequiredCommentRole(errorFragment, "message", "comment error template");
      if (!messageTarget) {
        return;
      }

      messageTarget.textContent = errorMessage;
      fragment.append(errorFragment);
    });
    return fragment;
  }

  if (successMessage) {
    const successFragment = cloneTemplateFragment(templates.success);
    const messageTarget = getRequiredCommentRole(successFragment, "message", "comment success template");
    if (!messageTarget) {
      return fragment;
    }

    messageTarget.textContent = successMessage;
    fragment.append(successFragment);
  }

  return fragment;
}

function createReplyFormFragment(node, templates, formValues = null) {
  const fragment = cloneTemplateFragment(templates.replyForm);
  const form = validateCommentFormFragment(fragment, {
    parentId: String(node.id || ""),
    values: formValues,
  });

  if (!form) {
    return null;
  }

  return fragment;
}

function createCommentItemFragment(node, templates, replyState, settings, depth = 0, formValues = null) {
  const fragment = cloneTemplateFragment(templates.item);
  const authorTarget = getRequiredCommentRole(fragment, "author", "comment item template");
  const dateTarget = getRequiredCommentRole(fragment, "date", "comment item template");
  const contentTarget = getRequiredCommentRole(fragment, "content", "comment item template");
  const replyFormTarget = getRequiredCommentRole(fragment, "reply-form", "comment item template");
  const repliesTarget = getRequiredCommentRole(fragment, "replies", "comment item template");

  if (!authorTarget || !dateTarget || !contentTarget || !replyFormTarget || !repliesTarget) {
    return null;
  }

  authorTarget.textContent = String(node.authorName || "");
  const machineDate = String(node.createdAt || "");
  dateTarget.textContent = machineDate;
  if (dateTarget instanceof HTMLTimeElement && machineDate) {
    dateTarget.dateTime = machineDate;
    dateTarget.setAttribute("title", machineDate);
    dateTarget.dataset.zpLocalDateTime = "";
    enhanceTimeElement(dateTarget, localDateTimeFormatter);
  }

  contentTarget.textContent = String(node.contentText || "");

  const avatarTarget = getCommentRole(fragment, "avatar");
  if (avatarTarget) {
    avatarTarget.textContent = getCommentInitials(node.authorName);
  }

  const itemRoot = fragment.querySelector('[data-role="comment-item"]');
  if (itemRoot instanceof HTMLElement) {
    itemRoot.dataset.commentId = String(node.id || "");
    itemRoot.dataset.commentDepth = String(depth);
  }

  const replyButton = fragment.querySelector('[data-action="reply"]');
  const canReply = settings.threadComments && depth < settings.threadDepth - 1;
  if (replyButton instanceof HTMLButtonElement) {
    if (!canReply) {
      replyButton.remove();
    } else {
      const isReplyOpen = replyState.activeCommentId === String(node.id || "");
      replyButton.dataset.replyCommentId = String(node.id || "");
      replyButton.dataset.replyOpen = isReplyOpen ? "true" : "false";
      replyButton.textContent = isReplyOpen ? "Cancel" : "Reply";
      replyButton.setAttribute("aria-expanded", isReplyOpen ? "true" : "false");
    }
  }

  if (canReply && replyState.activeCommentId === String(node.id || "")) {
    const activeFormValues = formValues &&
      String(formValues.parent || "") === String(node.id || "")
      ? formValues
      : null;
    const replyFormFragment = createReplyFormFragment(node, templates, activeFormValues);
    if (replyFormFragment) {
      replyFormTarget.append(replyFormFragment);
    }
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    node.children.forEach((childNode) => {
      const childFragment = createCommentItemFragment(childNode, templates, replyState, settings, depth + 1, formValues);
      if (childFragment) {
        repliesTarget.append(childFragment);
      }
    });
  }

  return fragment;
}

function createCommentListFragment(comments, templates, replyState, settings, formValues = null) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return cloneTemplateFragment(templates.empty);
  }

  const fragment = document.createDocumentFragment();
  buildCommentDisplayTree(comments, settings).forEach((rootNode) => {
    const itemFragment = createCommentItemFragment(rootNode, templates, replyState, settings, 0, formValues);
    if (itemFragment) {
      fragment.append(itemFragment);
    }
  });

  return fragment;
}

function createCommentsShellFragment(templates, options) {
  const {
    comments,
    errors = [],
    successMessage = "",
    showForm = true,
    showList = true,
    commentCount = Array.isArray(comments) ? comments.length : 0,
    pagination = null,
    replyState = { activeCommentId: null },
    commentSettings = { threadComments: true, threadDepth: 2 },
    formValues = null,
  } = options;

  const shellFragment = cloneTemplateFragment(templates.shell);
  const feedbackTarget = getRequiredCommentRole(shellFragment, "feedback", "comments shell template");
  const formTarget = getRequiredCommentRole(shellFragment, "form", "comments shell template");
  const listTarget = getRequiredCommentRole(shellFragment, "list", "comments shell template");

  if (!feedbackTarget || !formTarget || !listTarget) {
    return null;
  }

  const countTarget = getCommentRole(shellFragment, "count");
  if (countTarget) {
    countTarget.textContent = String(commentCount);
  }

  const paginationTarget = getCommentRole(shellFragment, "pagination");
  if (paginationTarget) {
    const loadMoreButton = paginationTarget.querySelector('[data-action="load-more"]');
    const canLoadMore = Boolean(
      pagination &&
      Number.isInteger(pagination.currentPage) &&
      Number.isInteger(pagination.totalPages) &&
      pagination.currentPage < pagination.totalPages,
    );

    paginationTarget.hidden = !canLoadMore;
    if (loadMoreButton instanceof HTMLButtonElement) {
      loadMoreButton.disabled = Boolean(pagination?.loading);
      loadMoreButton.textContent = pagination?.loading ? "Loading..." : "Load more";
    }
  }

  feedbackTarget.replaceChildren(createCommentFeedbackFragment(templates, errors, successMessage));

  if (showForm) {
    const formFragment = cloneTemplateFragment(templates.form);
    const form = validateCommentFormFragment(formFragment, {
      parentId: "",
      values: formValues && !String(formValues.parent || "") ? formValues : null,
    });
    if (!form) {
      return null;
    }
    formTarget.replaceChildren(formFragment);
  } else {
    formTarget.replaceChildren();
  }

  if (showList) {
    listTarget.replaceChildren(createCommentListFragment(comments, templates, replyState, commentSettings, formValues));
  } else {
    listTarget.replaceChildren();
  }
  return shellFragment;
}

function mergeCommentsById(existingComments, nextComments) {
  const merged = [];
  const seen = new Set();

  [...existingComments, ...nextComments].forEach((comment) => {
    const id = String(comment?.id || "");
    if (!id || seen.has(id)) {
      return;
    }

    seen.add(id);
    merged.push(comment);
  });

  return merged;
}

function commentSuccessMessage(wasPublished) {
  return wasPublished
    ? "Your comment has been posted."
    : "Your comment has been submitted and is awaiting moderation.";
}

function normalizeCommentsOrder(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return normalizedValue === "asc" || normalizedValue === "desc" ? normalizedValue : "";
}

function normalizeCommentsThreadComments(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === "false" || normalizedValue === "0" || normalizedValue === "no") {
    return false;
  }

  return true;
}

function normalizeCommentsThreadDepth(value) {
  const normalizedValue = String(value || "").trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 2;
  }

  const parsedValue = Number.parseInt(normalizedValue, 10);
  if (!Number.isInteger(parsedValue)) {
    return 2;
  }

  return Math.min(10, Math.max(2, parsedValue));
}

function getCommentSettings(mount) {
  return {
    threadComments: mount instanceof HTMLElement
      ? normalizeCommentsThreadComments(mount.dataset.zpCommentsThreadingEnabled)
      : true,
    threadDepth: mount instanceof HTMLElement
      ? normalizeCommentsThreadDepth(mount.dataset.zpCommentsThreadingMaxDepth)
      : 2,
    order: mount instanceof HTMLElement
      ? normalizeCommentsOrder(mount.dataset.zpCommentsOrder) || "desc"
      : "desc",
  };
}

class CommentController {
  constructor(mount, commentData) {
    this.mount = mount;
    this.commentData = commentData;
  }

  init() {
    const mount = this.mount;
    const commentData = this.commentData;
    const templates = resolveCommentsTemplates(mount);
    if (!templates) {
      mount.hidden = true;
      mount.replaceChildren();
      return;
    }

    let currentComments = [];
    let currentPage = 1;
    let totalPages = 1;
    let totalComments = 0;
    let isLoadingMore = false;
    const commentSettings = getCommentSettings(mount);

    const replyState = {
      activeCommentId: null,
    };

    const focusReplyForm = (commentId) => {
      if (!commentId) {
        return;
      }

      const commentItems = Array.from(mount.querySelectorAll('[data-role="comment-item"]'))
        .filter((element) => element instanceof HTMLElement);
      const targetItem = commentItems.find((element) => element.dataset.commentId === commentId);
      if (!(targetItem instanceof HTMLElement)) {
        return;
      }

      const textarea = targetItem.querySelector('.zp-comment__reply-slot textarea[name="content"]');
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.focus();
      }
    };

    const renderLoadedState = (options = {}) => {
      const {
        errors = [],
        successMessage = "",
        focusReplyCommentId = "",
        formValues = null,
      } = options;
      const shellFragment = createCommentsShellFragment(templates, {
        comments: currentComments,
        errors,
        successMessage,
        commentCount: totalComments || currentComments.length,
        pagination: {
          currentPage,
          totalPages,
          totalComments,
          loading: isLoadingMore,
        },
        showForm: true,
        replyState,
        commentSettings,
        formValues,
      });
      if (!shellFragment) {
        mount.hidden = true;
        mount.replaceChildren();
        return;
      }

      mount.replaceChildren(shellFragment);
      mount.hidden = false;
      bindCommentInteractions();

      if (focusReplyCommentId) {
        queueMicrotask(() => {
          focusReplyForm(focusReplyCommentId);
        });
      }
    };

    const renderErrorState = (errors) => {
      const shellFragment = createCommentsShellFragment(templates, {
        comments: [],
        errors: Array.isArray(errors) ? errors : [errors],
        commentCount: 0,
        showForm: false,
        showList: false,
        commentSettings,
      });
      if (!shellFragment) {
        mount.hidden = true;
        mount.replaceChildren();
        return;
      }

      mount.replaceChildren(shellFragment);
      mount.hidden = false;
    };

    const loadComments = async (options = {}) => {
      const {
        append = false,
        page = 1,
      } = options;

      let result;
      try {
        result = await commentData.load(page);
      } catch (error) {
        renderErrorState(getCommentDataErrorMessages(error));
        return false;
      }

      currentComments = append
        ? mergeCommentsById(currentComments, result.comments)
        : result.comments;
      currentPage = result.pagination?.currentPage || page;
      totalPages = result.pagination?.totalPages || currentPage;
      totalComments = result.pagination?.totalComments ?? currentComments.length;

      if (
        replyState.activeCommentId &&
        !currentComments.some((comment) => String(comment.id || "") === replyState.activeCommentId)
      ) {
        replyState.activeCommentId = null;
      }
      renderLoadedState({
        successMessage: options.successMessage || "",
      });
      return true;
    };

    const bindCommentInteractions = () => {
      const replyButtons = Array.from(mount.querySelectorAll('[data-action="reply"]'))
        .filter((element) => element instanceof HTMLButtonElement);

      replyButtons.forEach((button) => {
        if (button.dataset.replyReady === "true") {
          return;
        }

        button.dataset.replyReady = "true";
        button.addEventListener("click", () => {
          const commentId = String(button.dataset.replyCommentId || "");
          if (!commentId) {
            return;
          }

          const isAlreadyOpen = replyState.activeCommentId === commentId;
          replyState.activeCommentId = isAlreadyOpen ? null : commentId;
          renderLoadedState({
            focusReplyCommentId: isAlreadyOpen ? "" : commentId,
          });
        });
      });

      const cancelButtons = Array.from(mount.querySelectorAll('[data-action="cancel-reply"]'))
        .filter((element) => element instanceof HTMLButtonElement);

      cancelButtons.forEach((button) => {
        if (button.dataset.cancelReplyReady === "true") {
          return;
        }

        button.dataset.cancelReplyReady = "true";
        button.addEventListener("click", () => {
          replyState.activeCommentId = null;
          renderLoadedState();
        });
      });

      const loadMoreButtons = Array.from(mount.querySelectorAll('[data-action="load-more"]'))
        .filter((element) => element instanceof HTMLButtonElement);

      loadMoreButtons.forEach((button) => {
        if (button.dataset.loadMoreReady === "true") {
          return;
        }

        button.dataset.loadMoreReady = "true";
        button.addEventListener("click", async () => {
          if (isLoadingMore || currentPage >= totalPages) {
            return;
          }

          isLoadingMore = true;
          renderLoadedState();

          const loaded = await loadComments({
            append: true,
            page: currentPage + 1,
          });

          isLoadingMore = false;
          if (loaded) {
            renderLoadedState();
          }
        });
      });

      const forms = Array.from(mount.querySelectorAll("[data-zp-comment-form]"))
        .filter((element) => element instanceof HTMLFormElement);

      forms.forEach((form) => {
        if (form.dataset.commentFormReady === "true") {
          return;
        }

        form.dataset.commentFormReady = "true";
        form.addEventListener("submit", async (event) => {
          event.preventDefault();

          const parentIdField = form.querySelector('[name="parent"]');
          const parentId = parentIdField instanceof HTMLInputElement ? parentIdField.value.trim() : "";
          const formData = new FormData(form);
          const normalizedParentId = parsePositiveInteger(parentId);
          if (normalizedParentId > 0) {
            formData.set("parent", String(normalizedParentId));
          } else {
            formData.delete("parent");
          }

          const submittedFormValues = {
            parent: normalizedParentId > 0 ? String(normalizedParentId) : "",
            author_name: String(formData.get("author_name") || ""),
            author_email: String(formData.get("author_email") || ""),
            content: String(formData.get("content") || ""),
          };

          const websiteField = formData.get("website");
          if (typeof websiteField === "string" && websiteField.trim()) {
            renderLoadedState({
              successMessage: "Your comment has been submitted and is awaiting moderation.",
            });
            return;
          }

          let result;
          try {
            result = await commentData.submit({
              parentId: submittedFormValues.parent,
              authorName: submittedFormValues.author_name,
              authorEmail: submittedFormValues.author_email,
              content: submittedFormValues.content,
            });
          } catch (error) {
            replyState.activeCommentId = submittedFormValues.parent || null;
            renderLoadedState({
              errors: getCommentDataErrorMessages(error),
              focusReplyCommentId: submittedFormValues.parent,
              formValues: submittedFormValues,
            });
            return;
          }

          replyState.activeCommentId = null;
          const wasPublished = result.publication === "published";
          const successMessage = commentSuccessMessage(wasPublished);

          if (wasPublished) {
            await loadComments({
              successMessage,
            });
            return;
          }

          renderLoadedState({
            successMessage,
          });
        });
      });
    };

    void loadComments();
  }
}

function getCommentDataErrorMessages(error) {
  const dataApi = window.ZeroPressCommentData;
  if (dataApi && typeof dataApi.getErrorMessages === "function") {
    return dataApi.getErrorMessages(error);
  }
  return [normalizeCommentErrorMessage(error?.message || error)];
}

function initCommentMount(mount) {
  if (!(mount instanceof HTMLElement) || mount.dataset.commentsReady === "true") {
    return;
  }

  mount.dataset.commentsReady = "true";
  const targetPublicId = parseCommentTargetPublicId(mount);
  const dataApi = window.ZeroPressCommentData;
  if (!targetPublicId || !dataApi || typeof dataApi.create !== "function") {
    mount.hidden = true;
    mount.replaceChildren();
    reportCommentsContractError("Comment data runtime is unavailable.");
    return;
  }

  let commentData;
  try {
    commentData = dataApi.create({
      targetType: String(mount.dataset.zpCommentsTargetType || "").trim(),
      targetPublicId,
      provider: String(mount.dataset.zpCommentsProvider || "").trim(),
      apiBaseUrl: String(mount.dataset.zpCommentsApiBaseUrl || "").trim(),
      requestToken: String(mount.dataset.zpCommentsRequestToken || ""),
      perPage: mount.dataset.zpCommentsPerPage,
      order: mount.dataset.zpCommentsOrder,
    });
  } catch (error) {
    mount.hidden = true;
    mount.replaceChildren();
    reportCommentsContractError("Comment data initialization failed.", error);
    return;
  }

  new CommentController(mount, commentData).init();
}

function findCommentMounts(root = document) {
  const mounts = [];

  if (root instanceof HTMLElement && root.matches("[data-zp-comments]")) {
    mounts.push(root);
  }

  mounts.push(
    ...Array.from(root.querySelectorAll("[data-zp-comments]"))
      .filter((element) => element instanceof HTMLElement),
  );

  return mounts.filter((element) => element.dataset.commentsReady !== "true");
}

function scheduleCommentMount(mount) {
  if (!(mount instanceof HTMLElement) || mount.dataset.commentsLazyReady === "true") {
    return;
  }

  mount.dataset.commentsLazyReady = "true";
  const start = () => {
    delete mount.dataset.commentsLazyReady;
    initCommentMount(mount);
  };

  if (!("IntersectionObserver" in window)) {
    start();
    return;
  }

  const scope = mount.closest(".comments-block");
  const sentinel = scope?.querySelector("[data-zp-comments-sentinel]");
  const target = sentinel instanceof Element ? sentinel : mount;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
      return;
    }

    observer.disconnect();
    start();
  }, {
    rootMargin: "600px 0px",
    threshold: 0,
  });

  observer.observe(target);
}

function initComments(root = document) {
  findCommentMounts(root).forEach(scheduleCommentMount);
}

function initCommentsWhenReady() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initComments(document), { once: true });
    return;
  }

  initComments(document);
}

initCommentsWhenReady();
})();
