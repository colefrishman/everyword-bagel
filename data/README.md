# Scrabble word list

`scrabble-words.txt` is the headword list extracted from the **NWL2023** (North
American Word List, 2023 edition) Scrabble dictionary.

- Source: <https://github.com/scrabblewords/scrabblewords/blob/main/words/North-American/NWL2023.txt>
- Retrieved: 2026-10-27
- Words bundled: **196,601**
- Format: one uppercase headword per line, 2–21 letters, no definitions

This is a Scrabble tournament lexicon, not a general English dictionary. Expect
it to contain plenty of obscure two-letter words and not every modern brand
name. To refresh or replace it, run:

```sh
npm run fetch-dictionary
```

Set `NWL_SOURCE_URL` to fetch a different list (for example, a CSW list). The
game expects one headword per line; the fetch script extracts the first token
from NWL's `WORD definition` format.

NWL2023 is published by the North American Scrabble Players Association. This
copy is bundled for local, non-commercial play. If you redistribute this
project, review the applicable dictionary terms, or omit this file and run the
fetch script yourself.
