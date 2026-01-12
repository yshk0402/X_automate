const CONFIG = {
  TIMEZONE: 'Asia/Tokyo',
  SHEET_NAME: 'Posts',
  MAX_TEXT_LENGTH: null,
  NOTIFY_THROTTLE_MINUTES: 30,
  X_API_BASE_URL: 'https://api.x.com',
};

const POSTS_HEADERS = [
  'id',
  'scheduled_at',
  'text',
  'status',
  'created_at',
  'updated_at',
  'posted_at',
  'tweet_id',
  'error',
  'last_attempt_at',
  'attempt_count',
];

const POST_STATUS = {
  queued: 'queued',
  posting: 'posting',
  posted: 'posted',
  failed: 'failed',
  canceled: 'canceled',
};

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('X Scheduler');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function listPosts(startIso, endIso) {
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const rows = getDataRows_(sheet, headerMap);
  const start = startIso ? parseDateValue_(startIso) : null;
  const end = endIso ? parseDateValue_(endIso) : null;

  return rows
    .filter((row) => {
      const scheduledDate = parseDateValue_(row.scheduled_at);
      if (!scheduledDate) return false;
      if (start && scheduledDate < start) return false;
      if (end && scheduledDate >= end) return false;
      return true;
    })
    .map((row) => normalizePost_(row));
}

function createPost(payload) {
  const data = normalizePayload_(payload);
  const now = new Date();
  const nowIso = formatJstIso_(now);
  const record = {
    id: Utilities.getUuid(),
    scheduled_at: formatJstIso_(data.scheduled_at),
    text: data.text,
    status: POST_STATUS.queued,
    created_at: nowIso,
    updated_at: nowIso,
    posted_at: '',
    tweet_id: '',
    error: '',
    last_attempt_at: '',
    attempt_count: 0,
  };

  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const row = buildRow_(headerMap, record);
  sheet.appendRow(row);
  return normalizePost_(record);
}

function updatePost(id, payload) {
  const data = normalizePayload_(payload);
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const found = findPostRowById_(sheet, headerMap, id);
  if (!found) throw new Error('Post not found');
  const status = getCellValue_(found.rowValues, headerMap, 'status');
  if (status !== POST_STATUS.queued) {
    throw new Error('Only queued posts can be edited');
  }

  const updates = {
    scheduled_at: formatJstIso_(data.scheduled_at),
    text: data.text,
    updated_at: formatJstIso_(new Date()),
  };

  const updatedRow = updateRow_(sheet, headerMap, found.rowIndex, found.rowValues, updates);
  return rowToPost_(updatedRow, headerMap);
}

function movePost(id, newScheduledAt) {
  const scheduledDate = parseDateValue_(newScheduledAt);
  if (!scheduledDate) throw new Error('Invalid scheduled time');
  if (isPast_(scheduledDate)) throw new Error('Past time is not allowed');

  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const found = findPostRowById_(sheet, headerMap, id);
  if (!found) throw new Error('Post not found');
  const status = getCellValue_(found.rowValues, headerMap, 'status');
  if (status !== POST_STATUS.queued) {
    throw new Error('Only queued posts can be moved');
  }

  const updates = {
    scheduled_at: formatJstIso_(scheduledDate),
    updated_at: formatJstIso_(new Date()),
  };

  const updatedRow = updateRow_(sheet, headerMap, found.rowIndex, found.rowValues, updates);
  return rowToPost_(updatedRow, headerMap);
}

function cancelPost(id) {
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const found = findPostRowById_(sheet, headerMap, id);
  if (!found) throw new Error('Post not found');
  const status = getCellValue_(found.rowValues, headerMap, 'status');
  if (status !== POST_STATUS.queued) {
    throw new Error('Only queued posts can be canceled');
  }

  const updates = {
    status: POST_STATUS.canceled,
    updated_at: formatJstIso_(new Date()),
  };

  const updatedRow = updateRow_(sheet, headerMap, found.rowIndex, found.rowValues, updates);
  return rowToPost_(updatedRow, headerMap);
}

function retryPost(id) {
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const found = findPostRowById_(sheet, headerMap, id);
  if (!found) throw new Error('Post not found');
  const status = getCellValue_(found.rowValues, headerMap, 'status');
  if (status !== POST_STATUS.failed) {
    throw new Error('Only failed posts can be retried');
  }

  const updates = {
    status: POST_STATUS.queued,
    error: '',
    updated_at: formatJstIso_(new Date()),
  };

  const updatedRow = updateRow_(sheet, headerMap, found.rowIndex, found.rowValues, updates);
  clearFailureNotice_(id);
  return rowToPost_(updatedRow, headerMap);
}

function clearPosting(id, reason) {
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const found = findPostRowById_(sheet, headerMap, id);
  if (!found) throw new Error('Post not found');
  const status = getCellValue_(found.rowValues, headerMap, 'status');
  if (status !== POST_STATUS.posting) {
    throw new Error('Only posting status can be cleared');
  }

  const nowIso = formatJstIso_(new Date());
  const updates = {
    status: POST_STATUS.failed,
    error: truncate_(String(reason || 'Cleared'), 240),
    updated_at: nowIso,
    last_attempt_at: nowIso,
  };

  const updatedRow = updateRow_(sheet, headerMap, found.rowIndex, found.rowValues, updates);
  return rowToPost_(updatedRow, headerMap);
}

function runScheduler() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    processQueue_();
  } finally {
    lock.releaseLock();
  }
}

function ensureSchedulerTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some((trigger) => {
    return (
      trigger.getHandlerFunction() === 'runScheduler' &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK
    );
  });

  if (exists) return 'Trigger already exists';
  ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(5).create();
  return 'Trigger created';
}

function setXCredentials(consumerKey, consumerSecret, accessToken, accessTokenSecret) {
  const props = PropertiesService.getScriptProperties();
  if (consumerKey) props.setProperty('X_CONSUMER_KEY', consumerKey);
  if (consumerSecret) props.setProperty('X_CONSUMER_SECRET', consumerSecret);
  if (accessToken) props.setProperty('X_ACCESS_TOKEN', accessToken);
  if (accessTokenSecret) props.setProperty('X_ACCESS_TOKEN_SECRET', accessTokenSecret);
}

function processQueue_() {
  const sheet = ensurePostsSheet_();
  const headerMap = getHeaderMap_(sheet);
  const now = new Date();
  const due = findDuePost_(sheet, headerMap, now);
  if (!due) return;

  const nowIso = formatJstIso_(now);
  const attemptCount = Number(getCellValue_(due.rowValues, headerMap, 'attempt_count')) || 0;
  const postingUpdates = {
    status: POST_STATUS.posting,
    updated_at: nowIso,
    last_attempt_at: nowIso,
    attempt_count: attemptCount + 1,
  };

  const postingRow = updateRow_(sheet, headerMap, due.rowIndex, due.rowValues, postingUpdates);
  const postingPost = rowToPost_(postingRow, headerMap);

  try {
    const tweetId = postToX_(postingPost.text);
    const successUpdates = {
      status: POST_STATUS.posted,
      tweet_id: tweetId,
      posted_at: nowIso,
      updated_at: nowIso,
      error: '',
    };
    updateRow_(sheet, headerMap, due.rowIndex, null, successUpdates);
    clearFailureNotice_(postingPost.id);
  } catch (error) {
    const message = normalizeErrorMessage_(error);
    const failureUpdates = {
      status: POST_STATUS.failed,
      error: message,
      updated_at: nowIso,
      last_attempt_at: nowIso,
    };
    updateRow_(sheet, headerMap, due.rowIndex, null, failureUpdates);
    maybeNotifyFailure_(postingPost.id, postingPost.text, message);
  }
}

function ensurePostsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.getRange(1, 1, 1, POSTS_HEADERS.length).setValues([POSTS_HEADERS]);
  }
  return sheet;
}

function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet. Bind this script to a spreadsheet.');
  return ss;
}

function getHeaderMap_(sheet) {
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < POSTS_HEADERS.length) lastColumn = POSTS_HEADERS.length;
  let headerRow = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const hasAnyHeader = headerRow.some((value) => String(value || '').trim());

  if (!hasAnyHeader) {
    sheet.getRange(1, 1, 1, POSTS_HEADERS.length).setValues([POSTS_HEADERS]);
    headerRow = POSTS_HEADERS.slice();
    lastColumn = POSTS_HEADERS.length;
  }

  const indexByName = {};
  headerRow.forEach((name, index) => {
    if (!name) return;
    indexByName[String(name).trim()] = index;
  });

  const missing = POSTS_HEADERS.filter((name) => indexByName[name] === undefined);
  if (missing.length) {
    throw new Error(`Posts sheet header mismatch. Missing: ${missing.join(', ')}`);
  }

  return { headerRow, indexByName, count: lastColumn };
}

function getDataRows_(sheet, headerMap) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headerMap.count).getValues();
  return values.map((row) => rowToPost_(row, headerMap));
}

function findPostRowById_(sheet, headerMap, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, headerMap.count).getValues();
  const idIndex = headerMap.indexByName.id;

  for (let i = 0; i < values.length; i += 1) {
    if (values[i][idIndex] === id) {
      return { rowIndex: i + 2, rowValues: values[i] };
    }
  }
  return null;
}

function findDuePost_(sheet, headerMap, now) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, headerMap.count).getValues();
  const statusIndex = headerMap.indexByName.status;
  const scheduledIndex = headerMap.indexByName.scheduled_at;

  let selected = null;
  let selectedDate = null;

  for (let i = 0; i < values.length; i += 1) {
    const row = values[i];
    if (row[statusIndex] !== POST_STATUS.queued) continue;
    const scheduledDate = parseDateValue_(row[scheduledIndex]);
    if (!scheduledDate || scheduledDate > now) continue;

    if (!selectedDate || scheduledDate < selectedDate) {
      selected = { rowIndex: i + 2, rowValues: row };
      selectedDate = scheduledDate;
    }
  }

  return selected;
}

function buildRow_(headerMap, data) {
  const row = new Array(headerMap.count).fill('');
  Object.keys(headerMap.indexByName).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      row[headerMap.indexByName[key]] = data[key];
    }
  });
  return row;
}

function updateRow_(sheet, headerMap, rowIndex, rowValues, updates) {
  const values = rowValues
    ? rowValues.slice()
    : sheet.getRange(rowIndex, 1, 1, headerMap.count).getValues()[0];
  Object.keys(updates).forEach((key) => {
    const index = headerMap.indexByName[key];
    if (index === undefined) return;
    values[index] = updates[key];
  });
  sheet.getRange(rowIndex, 1, 1, headerMap.count).setValues([values]);
  return values;
}

function rowToPost_(rowValues, headerMap) {
  const post = {};
  Object.keys(headerMap.indexByName).forEach((key) => {
    post[key] = normalizeCellValue_(rowValues[headerMap.indexByName[key]]);
  });
  return post;
}

function normalizePost_(post) {
  return {
    id: post.id || '',
    scheduled_at: post.scheduled_at || '',
    posted_at: post.posted_at || '',
    text: post.text || '',
    status: post.status || POST_STATUS.queued,
    error: post.error || '',
    tweet_id: post.tweet_id || '',
    created_at: post.created_at || '',
    updated_at: post.updated_at || '',
    last_attempt_at: post.last_attempt_at || '',
    attempt_count: post.attempt_count || 0,
  };
}

function getCellValue_(rowValues, headerMap, key) {
  const index = headerMap.indexByName[key];
  if (index === undefined) return '';
  return rowValues[index];
}

function normalizeCellValue_(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (value instanceof Date) return formatJstIso_(value);
  return value;
}

function normalizePayload_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload');
  }

  const text = String(payload.text || '').trim();
  const scheduledAt = parseDateValue_(payload.scheduled_at);

  if (!scheduledAt) throw new Error('Invalid scheduled time');
  if (isPast_(scheduledAt)) throw new Error('Past time is not allowed');
  if (!text) throw new Error('Text is required');
  const limit = CONFIG.MAX_TEXT_LENGTH;
  if (typeof limit === 'number' && isFinite(limit) && text.length > limit) {
    throw new Error('Text is too long');
  }

  return { scheduled_at: scheduledAt, text };
}

function isPast_(date) {
  return date.getTime() < Date.now() - 60 * 1000;
}

function parseDateValue_(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatJstIso_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function truncate_(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function normalizeErrorMessage_(error) {
  if (!error) return 'Unknown error';
  if (error.message) return truncate_(String(error.message), 240);
  return truncate_(String(error), 240);
}

function maybeNotifyFailure_(postId, text, error) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = `FAILED_NOTICE_${postId}`;
    const last = Number(props.getProperty(key)) || 0;
    const now = Date.now();
    const threshold = CONFIG.NOTIFY_THROTTLE_MINUTES * 60 * 1000;
    if (now - last < threshold) return;

    const email = props.getProperty('NOTIFY_EMAIL') || Session.getActiveUser().getEmail();
    if (!email) return;

    const snippet = truncate_(String(text || ''), 120);
    const body = [
      'Post failed.',
      '',
      `id: ${postId}`,
      `text: ${snippet}`,
      `error: ${error}`,
    ].join('\n');

    MailApp.sendEmail(email, `X Scheduler failed: ${postId}`, body);
    props.setProperty(key, String(now));
  } catch (notifyError) {
    Logger.log(`Failed to send notify email: ${notifyError}`);
  }
}

function clearFailureNotice_(postId) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(`FAILED_NOTICE_${postId}`);
}

function postToX_(text) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Text is required');
  const limit = CONFIG.MAX_TEXT_LENGTH;
  if (typeof limit === 'number' && isFinite(limit) && content.length > limit) {
    throw new Error('Text is too long');
  }

  const credentials = getXCredentials_();
  const url = `${CONFIG.X_API_BASE_URL}/2/tweets`;
  const method = 'post';
  const oauthHeader = buildOAuthHeader_(method, url, credentials);
  const payload = JSON.stringify({ text: content });

  const response = UrlFetchApp.fetch(url, {
    method,
    contentType: 'application/json',
    payload,
    headers: {
      Authorization: oauthHeader,
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status !== 200 && status !== 201) {
    throw new Error(extractXErrorMessage_(status, body));
  }

  const data = JSON.parse(body);
  const tweetId = data && data.data ? data.data.id : '';
  if (!tweetId) throw new Error('X API response missing tweet id');
  return tweetId;
}

function getXCredentials_() {
  const props = PropertiesService.getScriptProperties();
  const consumerKey = props.getProperty('X_CONSUMER_KEY');
  const consumerSecret = props.getProperty('X_CONSUMER_SECRET');
  const accessToken = props.getProperty('X_ACCESS_TOKEN');
  const accessTokenSecret = props.getProperty('X_ACCESS_TOKEN_SECRET');

  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error('Missing X API credentials in script properties.');
  }

  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

function buildOAuthHeader_(method, url, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: generateNonce_(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  const paramString = buildParamString_(oauthParams);
  const baseString = [
    method.toUpperCase(),
    oauthEncode_(url),
    oauthEncode_(paramString),
  ].join('&');
  const signature = computeOAuthSignature_(
    baseString,
    credentials.consumerSecret,
    credentials.accessTokenSecret
  );
  oauthParams.oauth_signature = signature;

  const headerParams = Object.keys(oauthParams)
    .sort()
    .map((key) => `${oauthEncode_(key)}="${oauthEncode_(oauthParams[key])}"`)
    .join(', ');
  return `OAuth ${headerParams}`;
}

function buildParamString_(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${oauthEncode_(key)}=${oauthEncode_(params[key])}`)
    .join('&');
}

function computeOAuthSignature_(baseString, consumerSecret, tokenSecret) {
  const key = `${oauthEncode_(consumerSecret)}&${oauthEncode_(tokenSecret)}`;
  const signatureBytes = Utilities.computeHmacSha1Signature(baseString, key);
  return Utilities.base64Encode(signatureBytes);
}

function oauthEncode_(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function generateNonce_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function extractXErrorMessage_(status, body) {
  const fallback = `X API error (${status})`;
  if (!body) return fallback;

  try {
    const data = JSON.parse(body);
    if (data.errors && data.errors.length) {
      return `${fallback}: ${data.errors.map((item) => item.message).join('; ')}`;
    }
    if (data.detail) return `${fallback}: ${data.detail}`;
    if (data.title) return `${fallback}: ${data.title}`;
  } catch (error) {
    return fallback;
  }

  return fallback;
}
