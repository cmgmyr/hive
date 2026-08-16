# Attic: src/index.ts

Comments removed from `src/index.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 16

```
// Every tool registered below refuses an argument key it does not declare,
// instead of letting zod strip it silently. The reasoning is in
// src/strictInput.ts. Wrapped around the constructor rather than applied on
// the next line so there is no name in this file for an unwrapped server, and
// registering before the wrapper is in place cannot be written by accident.
```
