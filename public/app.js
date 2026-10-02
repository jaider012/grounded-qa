// Grounded Q&A frontend. Plain ES module, no framework, no build step.
// Every DOM node that can carry untrusted text (answers, citations, passages,
// uploaded file names) is built with createElement + textContent/createTextNode
// only. No HTML-string injection API is used anywhere in this file, since
// PDF text is untrusted. Icons are small inline SVGs built through
// createElementNS, never markup strings.

const MAX_QUESTION_CHARS = 500;
const CHAR_COUNTER_THRESHOLD = 80;
const CONFIRM_WINDOW_MS = 4000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const form = document.getElementById('ask-form');
const textarea = document.getElementById('question-input');
const charCounter = document.getElementById('char-counter');
const askButton = document.getElementById('ask-button');
const askError = document.getElementById('ask-error');
const answersSection = document.getElementById('answers');
const exampleButtons = document.querySelectorAll('.example-question');
const documentList = document.getElementById('document-list');
const addPdfButton = document.getElementById('add-pdf-button');
const pdfInput = document.getElementById('pdf-input');
const uploadStatus = document.getElementById('upload-status');

function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function createSvgElement(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

/** A small "x" used on the remove-document button. Single stroke weight, currentColor. */
function buildRemoveIcon() {
  const svg = createSvgElement('svg', { viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': 'true' });
  svg.appendChild(
    createSvgElement('line', {
      x1: '4',
      y1: '4',
      x2: '12',
      y2: '12',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    }),
  );
  svg.appendChild(
    createSvgElement('line', {
      x1: '12',
      y1: '4',
      x2: '4',
      y2: '12',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    }),
  );
  return svg;
}

/** A calm "nothing here" glyph (circle + dash) for the refusal state. Single stroke weight. */
function buildRefusalIcon() {
  const svg = createSvgElement('svg', {
    class: 'refusal-icon',
    viewBox: '0 0 24 24',
    width: '28',
    height: '28',
    'aria-hidden': 'true',
  });
  svg.appendChild(
    createSvgElement('circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }),
  );
  svg.appendChild(
    createSvgElement('line', {
      x1: '8',
      y1: '12',
      x2: '16',
      y2: '12',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    }),
  );
  return svg;
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

/** The collapsed "Retrieved passages (N)" details with its fixed-column table, built fresh per card. */
function buildRetrievedDetails(retrieved) {
  const details = document.createElement('details');
  details.className = 'retrieved-details';

  const summary = document.createElement('summary');
  summary.textContent = `Retrieved passages (${retrieved.length})`;
  details.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'retrieved-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Rank', 'Source', 'Location', 'Score']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
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

    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  details.appendChild(table);
  return details;
}

/** A decorative loading placeholder, not announced (the live region announces the real card once it lands). */
function buildSkeletonCard() {
  const card = document.createElement('article');
  card.className = 'answer-card skeleton-card';
  card.setAttribute('aria-hidden', 'true');
  for (const modifier of ['question', 'label', 'answer', 'answer-short']) {
    const line = document.createElement('div');
    line.className = `skeleton-line skeleton-line--${modifier}`;
    card.appendChild(line);
  }
  return card;
}

/** Builds one answer card: an answered card, or a calm "Not in the documents" refusal card. */
function buildAnswerCard(question, result) {
  const card = document.createElement('article');
  card.className = result.answerable ? 'answer-card' : 'answer-card answer-card--refusal';

  const questionEl = document.createElement('h2');
  questionEl.className = 'answer-card-question';
  questionEl.tabIndex = -1;
  questionEl.textContent = question;
  card.appendChild(questionEl);

  if (result.answerable) {
    const label = document.createElement('p');
    label.className = 'answer-card-label';
    label.textContent = 'Answer';
    card.appendChild(label);

    const answerText = document.createElement('p');
    answerText.className = 'answer-card-text';
    answerText.textContent = result.answer;
    card.appendChild(answerText);
  } else {
    const refusal = document.createElement('div');
    refusal.className = 'answer-refusal';
    refusal.appendChild(buildRefusalIcon());

    const label = document.createElement('p');
    label.className = 'answer-card-label';
    label.textContent = 'Not in the documents';
    refusal.appendChild(label);

    const answerText = document.createElement('p');
    answerText.className = 'answer-card-text';
    answerText.textContent = result.answer;
    refusal.appendChild(answerText);

    const hint = document.createElement('p');
    hint.className = 'answer-refusal-hint';
    hint.textContent = 'Try rephrasing your question, or add a PDF that covers it.';
    refusal.appendChild(hint);

    card.appendChild(refusal);
  }

  if (Array.isArray(result.citations) && result.citations.length > 0) {
    const sourcesLabel = document.createElement('p');
    sourcesLabel.className = 'answer-sources-label';
    sourcesLabel.textContent = 'Sources';
    card.appendChild(sourcesLabel);

    const sources = document.createElement('ul');
    sources.className = 'answer-sources';
    for (const citation of result.citations) {
      const item = document.createElement('li');
      item.className = 'source-item';

      const head = document.createElement('p');
      head.className = 'source-head';
      head.textContent = `${citation.source} · ${citation.location}`;
      item.appendChild(head);

      const passageEl = document.createElement('p');
      passageEl.className = 'source-passage';
      appendHighlightedPassage(passageEl, citation.passage, citation.quote);
      item.appendChild(passageEl);

      sources.appendChild(item);
    }
    card.appendChild(sources);
  }

  card.appendChild(buildRetrievedDetails(Array.isArray(result.retrieved) ? result.retrieved : []));

  return card;
}

function prependCard(node) {
  answersSection.insertBefore(node, answersSection.firstChild);
}

/** Shows a short hint only when the answers stack is empty; removes it otherwise. */
function updateEmptyHint() {
  const hasCards = answersSection.querySelector('.answer-card') !== null;
  const existingHint = answersSection.querySelector('.answers-empty-hint');
  if (hasCards) {
    if (existingHint) existingHint.remove();
    return;
  }
  if (existingHint) return;
  const hint = document.createElement('p');
  hint.className = 'answers-empty-hint';
  hint.textContent = 'Ask a question above, or try an example, to see an answer here.';
  answersSection.appendChild(hint);
}

function setBusy(isBusy) {
  askButton.disabled = isBusy;
  askButton.textContent = isBusy ? 'Asking…' : 'Ask';
  answersSection.setAttribute('aria-busy', String(isBusy));
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
  const skeleton = buildSkeletonCard();
  prependCard(skeleton);
  updateEmptyHint();

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const body = await response.json().catch(() => null);
    skeleton.remove();

    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : 'Something went wrong. Try again.';
      showError(message);
      updateEmptyHint();
      return;
    }

    const card = buildAnswerCard(question, body);
    prependCard(card);
    const heading = card.querySelector('.answer-card-question');
    if (heading) heading.focus();
  } catch {
    skeleton.remove();
    showError('Could not reach the server. Check your connection and try again.');
    updateEmptyHint();
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

async function removeDocument(name, onFailureReset) {
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message = body && typeof body.error === 'string' ? body.error : 'Could not remove that document.';
      uploadStatus.textContent = message;
      onFailureReset();
      return;
    }

    renderDocuments(Array.isArray(body.documents) ? body.documents : []);
    uploadStatus.textContent = `Removed ${name}.`;
  } catch {
    uploadStatus.textContent = 'Could not reach the server. Check your connection and try again.';
    onFailureReset();
  }
}

/**
 * A remove button that, on first click, turns into an inline "Confirm" for a
 * few seconds (no modal, no confirm()); a second click within that window
 * sends the DELETE. Reverts on timeout or on a failed delete.
 */
function buildRemoveButton(name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'document-remove';
  button.setAttribute('aria-label', `Remove ${name}`);
  button.appendChild(buildRemoveIcon());

  let confirming = false;
  let revertTimer = null;

  function reset() {
    confirming = false;
    if (revertTimer !== null) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
    clearChildren(button);
    button.classList.remove('document-remove--confirming');
    button.setAttribute('aria-label', `Remove ${name}`);
    button.appendChild(buildRemoveIcon());
  }

  button.addEventListener('click', () => {
    if (!confirming) {
      confirming = true;
      clearChildren(button);
      button.textContent = 'Confirm';
      button.classList.add('document-remove--confirming');
      button.setAttribute('aria-label', `Confirm removing ${name}`);
      revertTimer = setTimeout(reset, CONFIRM_WINDOW_MS);
      return;
    }
    if (revertTimer !== null) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
    removeDocument(name, reset);
  });

  return button;
}

function buildDocumentItem(doc) {
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

  if (doc.builtIn) {
    const badge = document.createElement('span');
    badge.className = 'builtin-badge';
    badge.textContent = 'Built-in';
    item.appendChild(badge);
  } else {
    item.appendChild(buildRemoveButton(doc.name));
  }

  return item;
}

function renderDocuments(documents) {
  clearChildren(documentList);
  for (const doc of documents) {
    documentList.appendChild(buildDocumentItem(doc));
  }
}

async function loadDocuments() {
  try {
    const response = await fetch('/api/documents');
    if (!response.ok) return;
    const body = await response.json();
    renderDocuments(Array.isArray(body.documents) ? body.documents : []);
  } catch {
    // The list just keeps its last known state; the ask flow surfaces connectivity problems.
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

updateEmptyHint();
updateCharCounter();
loadDocuments();
