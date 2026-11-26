// Test-case cards.
//
// Each test is a collapsible card with an editable input and expected output. Only open cards put their
// text into the page, which keeps tests of several megabytes fast. In demo builds, either box can also be
// loaded from a file of any type.

/** @typedef {import('./state.js').Test} Test */

/**
 * Fetch a text file from this build.
 * @param {string} path
 * @returns {Promise<string>}
 */
async function fetchText(path) {
  const response = await fetch(new URL(path, import.meta.url));
  return response.text();
}

/**
 * Return a test's input. An unopened demo test's input is read from its file.
 * @param {Test} test
 * @returns {Promise<string>}
 */
export async function inputOf(test) {
  return test.input ?? fetchText(`demo/${test.file}.in`);
}

/**
 * Return a test's expected output. An unopened demo test's output is read from its file.
 * @param {Test} test
 * @returns {Promise<string>}
 */
export async function expectedOf(test) {
  return test.expected ?? fetchText(`demo/${test.file}.out`);
}

/**
 * Ask the user to choose a file, of any type, and read it as text.
 * @returns {Promise<string|null>} The file's text, or null if the user cancelled.
 */
function pickFile() {
  return new Promise((resolve) => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.onchange = () => {
      const file = picker.files[0];
      if (file) file.text().then(resolve);
      else resolve(null);
    };
    picker.oncancel = () => resolve(null);
    picker.click();
  });
}

/**
 * Draw a tab's test cases as cards, using the page's #test template.
 * @param {HTMLElement} list  The element to draw into.
 * @param {Test[]} tests
 * @param {object} options
 * @param {() => void} options.onChange  Called after any edit.
 * @param {boolean} options.allowImport  Whether to show the "Load file" buttons.
 */
export function renderTests(list, tests, options) {
  const cards = tests.map((test, i) => renderCard(list, tests, test, i, options));
  list.replaceChildren(...cards);
}

/**
 * Create the card for one test.
 * @param {HTMLElement} list  The element that holds the cards, which is redrawn when a test is deleted.
 * @param {Test[]} tests  All of the tab's tests.
 * @param {Test} test  This test.
 * @param {number} i  Its position.
 * @param {object} options  As for renderTests.
 * @param {() => void} options.onChange
 * @param {boolean} options.allowImport
 * @returns {HTMLElement}
 */
function renderCard(list, tests, test, i, options) {
  const { onChange, allowImport } = options;
  const card = document.getElementById('test').content.firstElementChild.cloneNode(true);
  card.querySelector('.name').textContent = `Test ${i + 1}`;
  const boxes = {
    input: card.querySelector('.in'),
    expected: card.querySelector('.exp'),
  };

  // Put the test's text into the boxes, reading a demo test's files the first time.
  const fill = async () => {
    if (test.input == null) {
      [test.input, test.expected] = await Promise.all([inputOf(test), expectedOf(test)]);
    }
    boxes.input.value = test.input;
    boxes.expected.value = test.expected;
  };

  card.open = test.open ?? true;
  if (card.open) fill();
  card.ontoggle = () => {
    test.open = card.open;
    if (card.open) fill();
  };

  for (const [field, box] of Object.entries(boxes)) {
    box.oninput = () => {
      test[field] = box.value;
      test.edited = true;
      onChange();
    };

    const load = card.querySelector(`.load-${field}`);
    load.hidden = !allowImport;
    load.onclick = async (event) => {
      event.preventDefault(); // The button is inside a <label>, which would otherwise focus the box.
      const text = await pickFile();
      if (text == null) return;
      await fill(); // Read a demo test's files first, so that the other box keeps its text.
      test[field] = text;
      box.value = text;
      test.edited = true;
      onChange();
    };
  }

  card.querySelector('.del').onclick = (event) => {
    event.preventDefault(); // The button is inside <summary>, which would otherwise toggle the card.
    tests.splice(i, 1);
    renderTests(list, tests, options);
    onChange();
  };

  return card;
}
