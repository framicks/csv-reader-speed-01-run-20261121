// csv-reader-speed-01: a fast drop-in for csv-reader 1.0.0.
// Single-pass scanner: fields are sliced out of the text, never built
// character by character. Delimiters are found with indexOf (C++ speed);
// only a field that actually holds a stray CR falls back to a slow scan.
// Semantics follow csv-reader 1.0.0 exactly:
//  - a U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF; a line left with no characters is no record;
//  - outside quotes a CR not followed by LF is dropped (stray_cr);
//  - a field opening with a quote runs to the next non-doubled quote ("" is one
//    quote, CRLF/lone CR inside read as LF); text after the closing quote up to
//    the next comma or line break is appended as-is (quote_junk when the field
//    ends); a quote that never closes is literal and the text after it is read
//    again as unquoted (unterminated_quote);
//  - a quote inside an unquoted field is literal; fields stay strings;
//  - columns is the first record when header is true, else null; rows are the
//    records after it, each padded (short_row, with fields: its count) or cut
//    (long_row, with extra: the cut fields) to the first record's width;
//  - each error is {code, line, row} in the order met; line is the 1-based line
//    its record starts on (counting every LF, CRLF and lone CR inside quotes),
//    row its record's index in rows, null for the header.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r

// Append text[a..b) onto val, converting every CR, CRLF and LF to one LF and
// counting the lines they end. Only used for a quoted segment that actually
// holds a line break; returns [value, line].
function appendSegment(text, val, a, b, line) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = text.charCodeAt(j);
      if (c === CR || c === LF) break;
      j++;
    }
    if (j > i) val += text.slice(i, j);
    if (j >= b) break;
    const c = text.charCodeAt(j);
    val += '\n';
    line += 1;
    j += 1;
    if (c === CR && text.charCodeAt(j) === LF) j += 1; // CRLF is one break
    i = j;
  }
  return [val, line];
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;

    // One record: fields until a field ends at a line break or the end.
    while (true) {
      let value;
      let ended; // 0 = comma, 1 = line break, 2 = end of text
      let scanUnquoted = false;
      let junkCheck = false;

      if (text.charCodeAt(pos) === QUOTE) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let seg = pos + 1; // start of the segment inside the quotes
        let val = '';
        let closed = false;
        let closeAt = -1;
        while (true) {
          const q = text.indexOf('"', seg);
          if (q === -1) break; // no quote left: unterminated
          if (text.charCodeAt(q + 1) === QUOTE) {
            // Doubled quote: one quote, and the field goes on.
            const part = text.slice(seg, q);
            if (part.indexOf('\r') === -1 && part.indexOf('\n') === -1) {
              val += part;
            } else {
              const r = appendSegment(text, val, seg, q, line);
              val = r[0];
              line = r[1];
            }
            val += '"';
            seg = q + 2;
            continue;
          }
          closeAt = q;
          closed = true;
          const part = text.slice(seg, q);
          if (part.indexOf('\r') === -1 && part.indexOf('\n') === -1) {
            val += part;
          } else {
            const r = appendSegment(text, val, seg, q, line);
            val = r[0];
            line = r[1];
          }
          break;
        }
        if (!closed) {
          // The quote never closes: it is literal, and the text after it is
          // read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          value = '"';
          scanUnquoted = true;
        } else {
          pos = closeAt + 1;
          if (pos >= n) {
            value = val;
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === COMMA) {
              value = val;
              pos += 1;
              ended = 0;
            } else if (c === LF) {
              value = val;
              line += 1;
              pos += 1;
              ended = 1;
            } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
              value = val;
              line += 1;
              pos += 2;
              ended = 1;
            } else {
              // What follows the closing quote is appended as it stands.
              value = val;
              scanUnquoted = true;
              junkCheck = true;
            }
          }
        }
      } else {
        quoted = false;
        value = '';
        scanUnquoted = true;
      }

      if (scanUnquoted) {
        // Read unquoted characters onto value up to the next comma or line
        // break; a CR not followed by LF is dropped (stray_cr). `added`
        // counts the characters kept, for the quote_junk check.
        let added = 0;
        let p = pos;
        ended = 2;
        scanLoop: while (true) {
          const cComma = text.indexOf(',', p);
          const cLf = text.indexOf('\n', p);
          let end;
          let kind; // 0 = comma, 1 = line break, 2 = end of text
          if (cComma === -1 && cLf === -1) {
            end = n;
            kind = 2;
          } else if (cLf === -1 || (cComma !== -1 && cComma < cLf)) {
            end = cComma;
            kind = 0;
          } else {
            end = cLf;
            kind = 1;
          }
          // A CR right before the LF is the CRLF ending, not part of the field.
          let segEnd = end;
          if (kind === 1 && end > p && text.charCodeAt(end - 1) === CR) segEnd = end - 1;
          const seg = text.slice(p, segEnd);
          if (seg.indexOf('\r') === -1) {
            if (segEnd > p) {
              value += seg;
              added += segEnd - p;
            }
            if (kind === 0) {
              pos = end + 1;
              ended = 0;
            } else if (kind === 1) {
              line += 1;
              pos = end + 1;
              ended = 1;
            } else {
              pos = n;
              ended = 2;
            }
            break scanLoop;
          }
          // A stray CR sits in the segment: slow scan from p.
          let i = p;
          let segStart = p;
          while (true) {
            while (i < n) {
              const c = text.charCodeAt(i);
              if (c === COMMA || c === LF || c === CR) break;
              i += 1;
            }
            if (i >= n) {
              if (i > segStart) {
                value += text.slice(segStart, i);
                added += i - segStart;
              }
              pos = i;
              ended = 2;
              break scanLoop;
            }
            const c = text.charCodeAt(i);
            if (c === COMMA) {
              if (i > segStart) {
                value += text.slice(segStart, i);
                added += i - segStart;
              }
              pos = i + 1;
              ended = 0;
              break scanLoop;
            }
            if (c === LF) {
              if (i > segStart) {
                value += text.slice(segStart, i);
                added += i - segStart;
              }
              line += 1;
              pos = i + 1;
              ended = 1;
              break scanLoop;
            }
            // CR: a line break when followed by LF, else a stray CR, dropped.
            if (text.charCodeAt(i + 1) === LF) {
              if (i > segStart) {
                value += text.slice(segStart, i);
                added += i - segStart;
              }
              line += 1;
              pos = i + 2;
              ended = 1;
              break scanLoop;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (i > segStart) {
              value += text.slice(segStart, i);
              added += i - segStart;
            }
            i += 1;
            segStart = i;
          }
        }
        if (junkCheck && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
