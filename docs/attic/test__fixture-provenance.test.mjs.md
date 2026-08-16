# Attic: test/fixture-provenance.test.mjs

Comments removed from `test/fixture-provenance.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// test/fixtures/native-addon-abi/ holds four third-party BINARIES that this
// suite dlopen()s, and its README carried a sha256 for each one. Nothing
// hashed them. A provenance table nobody checks is a claim about four
// executables, and this project would flag exactly that shape in someone
// else's repo (hive todo 297 item 2).
//
// THE README IS THE CHECK, rather than a second table copied into this file.
// Two tables drift, and the failure mode of drift here is that the enforced
// copy quietly becomes the authority while the human-readable one still says
// something else. Parsing the README means an edit to the documented hash is
// an edit to the assertion, and there is nowhere for the two to disagree.
```

## line 26

```
// The table's data rows: | `file.node` | source | ABI | `sha256` |. Anchored on
// a backticked .node filename in the first cell so the header and separator
// rows cannot match, and so a future table elsewhere in the file needs its own
// parser rather than silently feeding this one.
```

## line 43

```
// Both directions. Without the first, a fixture added without a table row
// is unchecked and this test still passes; without the second, a row whose
// file was renamed or deleted passes too, and the table starts describing
// something that is not there. The README's own instruction to ADD a pair
// when CI's matrix moves is the case that makes the first direction live.
```

## line 67

```
// From lane B1's teardown (hive todo 297 comment 528 item 3). classic-package
// shipped without its LICENSE while vendor/bindings and vendor/file-uri-to-path
// both carried theirs, so the omission read as deliberate rather than
// forgotten, and it survived a review round and a gate. MIT requires the
// notice to travel with the copy, so the rule is per vendored package, not
// per directory tree.
```
