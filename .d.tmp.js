const fs = require('fs');
const p = '__e2e_tests__/2c-pressLine.e2e.js';
let t = fs.readFileSync(p, 'utf8');
const N = '\n';

/* announced digits, with their values - not just a count */
const old = "const appended = said => (said.match(/password appended with (\d)/g) || []).length;" + N;
if (!t.includes(old)) { console.error('MISS a'); process.exit(1); }
t = t.replace(old,
"/**" + N +
" * Which digits the firmware announced since the last take()." + N +
" *" + N +
" * The VALUES, not a count. A count cannot tell a press this test caused from" + N +
" * one left over from the control press or the status broadcast, and that" + N +
" * ambiguity already produced one wrong reading of this probe." + N +
" */" + N +
"const appended = said =>" + N +
"  (said.match(/password appended with (\d)/g) || []).map(s => Number(s.slice(-1)));" + N);

/* control presses 1; the console writes 3 */
t = t.replace("        await OkEmu.pressButton(1);" + N,
              "        await OkEmu.pressButton(CONTROL_BUTTON);" + N);
t = t.replace("        assert.equal(" + N +
"          appended(said), 1," + N,
"        assert.deepEqual(" + N +
"          appended(said), [CONTROL_BUTTON]," + N);
t = t.replace("        await device.press('1');" + N,
              "        await device.press(String(CONSOLE_BUTTON));" + N);
t = t.replace("        log('wrote \"1\" to SEREMU via device.press (pressLine)');" + N,
              "        log(`wrote \"${CONSOLE_BUTTON}\" to SEREMU via device.press (pressLine)`);" + N);

/* the buttons, named */
t = t.replace("let shared = null;" + N,
"/*" + N +
" * DIFFERENT BUTTONS on purpose. The control presses one and the console asks" + N +
" * for another, so an announcement can be attributed rather than assumed - the" + N +
" * first version of this probe counted announcements and read a leftover as a" + N +
" * success." + N +
" */" + N +
"const CONTROL_BUTTON = 1;" + N +
"const CONSOLE_BUTTON = 3;" + N + N +
"let shared = null;" + N);

/* attribute by value */
t = t.replace("        const count = appended(said);" + N,
              "        const digits = appended(said);" + N +
              "        const count = digits.filter(d => d === CONSOLE_BUTTON).length;" + N +
              "        log(`announced digits: ${JSON.stringify(digits)}`);" + N);

fs.writeFileSync(p, t);
console.log('ok');
