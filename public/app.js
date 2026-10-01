// Grounded Q&A frontend. Plain ES module, no framework, no build step.
// Every DOM node that can carry untrusted text (answers, citations, passages,
// uploaded file names) is built with createElement + textContent/createTextNode
// only. No HTML-string injection API is used anywhere in this file, since
// PDF text is untrusted.

const MAX_QUESTION_CHARS = 500;
const CHAR_COUNTER_THRESHOLD = 80;

const form = document.getElementById('ask-form');
const textarea = document.getElementById('question-input');
const charCounter = document.getElementById('char-counter');
const askButton = document.getElementById('ask-button');
const askError = document.getElementById('ask-error');
const rail = document.querySelector('.rail');
const ticketSlot = document.querySelector('.ticket-slot');
const exampleButtons = document.querySelectorAll('.example-question');
const detailsSummary = document.querySelector('.retrieved-details summary');
const retrievedBody = document.getElementById('retrieved-body');
const documentList = document.getElementById('document-list');
const addPdfButton = document.getElementById('add-pdf-button');
const pdfInput = document.getElementById('pdf-input');
const uploadStatus = document.getElementById('upload-status');

/** Formats a Date as 24-hour "HH:MM", for the ticket's order strip. */
function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Appends `passage` to `container` as text nodes, wrapping the exact `quote`
 * substring in a <mark>. The backend guarantees `quote` is a verbatim
 * substring of `passage` (found with `passage.indexOf(quote)`), so a plain
 * indexOf split is enough. Falls back to plain text if it is ever not found.
 */
function appendHighlightedPassage(container, passage, quote) {
  const index = passage.indexOf(quote);
  if (index === -1) {
    container.appendChild(document.createTextNode(passage));
    return;
  }
  if (index > 0) {
    container.appendChild(document.createTextNode(passage.slice(0, index)));
  }
  const mark = document.createElement('mark');
  mark.textContent = quote;
  container.appendChild(mark);
  const after = index + quote.length;
  if (after < passage.length) {
    container.appendChild(document.createTextNode(passage.slice(after)));
  }
}

function buildRule() {
  const rule = document.createElement('div');
  rule.className = 'ticket-rule';
  rule.setAttribute('aria-hidden', 'true');
  return rule;
}

/** The blank ticket shown before any question has been asked, and after a failed request. */
function buildEmptyTicket() {
  const ticket = document.createElement('div');
  ticket.className = 'ticket ticket--empty';

  const strip = document.createElement('div');
  strip.className = 'ticket-strip ticket-strip--empty';
  strip.setAttribute('aria-hidden', 'true');
  ticket.appendChild(strip);

  const message = document.createElement('p');
  message.className = 'ticket-empty-message';
  message.textContent =
    'Ask a question above, try an example, or add a PDF. Answers come only from the documents on the shelf.';
  ticket.appendChild(message);

  return ticket;
}

/** A decorative loading placeholder, not announced (the live region announces the real ticket once it lands). */
function buildSkeletonTicket() {
  const ticket = document.createElement('div');
  ticket.className = 'ticket ticket--loading';
  ticket.setAttribute('aria-hidden', 'true');

  for (const modifier of ['strip', 'question', 'answer', 'answer-short']) {
    const line = document.createElement('div');
    line.className = `skeleton-line skeleton-line--${modifier}`;
    ticket.appendChild(line);
  }

  return ticket;
}

/** Builds the real ticket for an /api/ask result: an answer ticket, or an 86-stamped refusal. */
function buildTicket(question, result) {
  const ticket = document.createElement('div');
  ticket.className = result.answerable ? 'ticket' : 'ticket ticket--refused';

  const strip = document.createElement('div');
  strip.className = 'ticket-strip';
  const stripTime = document.createElement('span');
  stripTime.className = 'ticket-strip-time';
  stripTime.textContent = formatTime(new Date());
  const stripLabel = document.createElement('span');
  stripLabel.className = 'ticket-strip-label';
  stripLabel.textContent = 'Order';
  strip.appendChild(stripTime);
  strip.appendChild(stripLabel);
  ticket.appendChild(strip);

  const heading = document.createElement('h2');
  heading.className = 'ticket-heading visually-hidden';
  heading.id = 'ticket-heading';
  heading.tabIndex = -1;
  heading.textContent = result.answerable ? 'Order answered' : 'Order refused, stamped 86';
  ticket.appendChild(heading);

  const questionLine = document.createElement('p');
  questionLine.className = 'ticket-question';
  questionLine.textContent = question;
  ticket.appendChild(questionLine);

  ticket.appendChild(buildRule());

  if (!result.answerable) {
    const stamp = document.createElement('div');
    stamp.className = 'ticket-stamp';
    stamp.textContent = '86';
    ticket.appendChild(stamp);
  }

  const answerLine = document.createElement('p');
  answerLine.className = 'ticket-answer';
  answerLine.textContent = result.answer;
  ticket.appendChild(answerLine);

  if (!result.answerable) {
    const hint = document.createElement('p');
    hint.className = 'ticket-refusal-hint';
    hint.textContent = 'Nothing in the loaded documents covers this question.';
    ticket.appendChild(hint);
  }

  if (Array.isArray(result.citations) && result.citations.length > 0) {
    ticket.appendChild(buildRule());
    const list = document.createElement('ul');
    list.className = 'ticket-citations';
    for (const citation of result.citations) {
      const item = document.createElement('li');
      item.className = 'ticket-citation';

      const head = document.createElement('p');
      head.className = 'ticket-citation-head';
      head.textContent = `${citation.source} · ${citation.location}`;
      item.appendChild(head);

      const passageEl = document.createElement('p');
      passageEl.className = 'ticket-citation-passage';
      appendHighlightedPassage(passageEl, citation.passage, citation.quote);
      item.appendChild(passageEl);

      list.appendChild(item);
    }
    ticket.appendChild(list);
  }

  return ticket;
}

function renderRail(node) {
  clearChildren(ticketSlot);
  ticketSlot.appendChild(node);
}

function renderRetrieved(retrieved) {
  if (detailsSummary) {
    detailsSummary.textContent = `Retrieved passages (${retrieved.length})`;
  }
  clearChildren(retrievedBody);
  retrieved.forEach((passage, index) => {
    const row = document.createElement('tr');

    const rank = document.createElement('td');
    rank.textContent = String(index + 1);
    row.appendChild(rank);

    const source = document.createElement('td');
    source.textContent = passage.source;
    row.appendChild(source);

    const location = document.createElement('td');
    location.textContent = passage.location;
    row.appendChild(location);

    const score = document.createElement('td');
    score.className = 'score-cell';
    score.textContent = passage.score.toFixed(3);
    row.appendChild(score);

    retrievedBody.appendChild(row);
  });
}

function setBusy(isBusy) {
  askButton.disabled = isBusy;
  askButton.textContent = isBusy ? 'Asking…' : 'Ask';
  rail.setAttribute('aria-busy', String(isBusy));
}

function showError(message) {
  askError.textContent = message;
}

function clearError() {
  askError.textContent = '';
}

async function askQuestion(question) {
  clearError();
  setBusy(true);
  renderRail(buildSkeletonTicket());

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : 'Something went wrong. Try again.';
      showError(message);
      renderRail(buildEmptyTicket());
      return;
    }

    renderRail(buildTicket(question, body));
    renderRetrieved(Array.isArray(body.retrieved) ? body.retrieved : []);

    const heading = document.getElementById('ticket-heading');
    if (heading) heading.focus();
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
    renderRail(buildEmptyTicket());
  } finally {
    setBusy(false);
  }
}

function triggerAsk() {
  if (askButton.disabled) return;
  const question = textarea.value.trim();
  if (question.length === 0) return;
  askQuestion(question);
}

function updateCharCounter() {
  const remaining = MAX_QUESTION_CHARS - textarea.value.length;
  charCounter.textContent = remaining <= CHAR_COUNTER_THRESHOLD ? `${remaining} characters left` : '';
}

function renderDocuments(documents) {
  clearChildren(documentList);
  const maxChunks = Math.max(1, ...documents.map((doc) => doc.chunks));

  for (const doc of documents) {
    const item = document.createElement('li');
    item.className = 'document-item';

    const name = document.createElement('span');
    name.className = 'document-name';
    name.textContent = doc.name;
    item.appendChild(name);

    const count = document.createElement('span');
    count.className = 'document-count';
    count.textContent = pluralize(doc.chunks, 'passage');
    item.appendChild(count);

    const bar = document.createElement('div');
    bar.className = 'extent-bar';
    const fill = document.createElement('div');
    fill.className = 'extent-bar-fill';
    fill.style.setProperty('--extent', String(doc.chunks / maxChunks));
    bar.appendChild(fill);
    item.appendChild(bar);

    documentList.appendChild(item);
  }
}

async function loadDocuments() {
  try {
    const response = await fetch('/api/documents');
    if (!response.ok) return;
    const body = await response.json();
    renderDocuments(Array.isArray(body.documents) ? body.documents : []);
  } catch {
    // The shelf just keeps its last known state; the ask flow surfaces connectivity problems.
  }
}

async function uploadPdf(file) {
  uploadStatus.textContent = `Adding ${file.name}…`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/api/documents', { method: 'POST', body: formData });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : 'The upload failed. Try again.';
      uploadStatus.textContent = message;
      return;
    }

    const addedDocument = body.document;
    uploadStatus.textContent = `Added ${addedDocument.name}, ${pluralize(addedDocument.chunks, 'passage')}`;
    await loadDocuments();
  } catch {
    uploadStatus.textContent = 'Could not reach the server. Check your connection and try again.';
  } finally {
    pdfInput.value = '';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  triggerAsk();
});

textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

textarea.addEventListener('input', updateCharCounter);

exampleButtons.forEach((button) => {
  button.addEventListener('click', () => {
    textarea.value = button.textContent ?? '';
    updateCharCounter();
    triggerAsk();
  });
});

addPdfButton.addEventListener('click', () => {
  pdfInput.click();
});

pdfInput.addEventListener('change', () => {
  const file = pdfInput.files && pdfInput.files[0];
  if (file) uploadPdf(file);
});

renderRail(buildEmptyTicket());
updateCharCounter();
loadDocuments();
