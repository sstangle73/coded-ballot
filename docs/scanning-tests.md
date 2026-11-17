# Scanning tests

The mark reader (`packages/core/src/scan.ts`) is tested automatically on synthetic sheets: drawn from the real layout,
then photographed at an angle, unevenly lit, noisy and upside down (`packages/core/test/scan.test.ts`). It has also
read ballots printed by the issuer tool, rasterised at 150 dpi and marked, including a skewed "phone photo" of one,
in the tellers' app on the demo server.

What synthetic images can't show is real paper, real pens, real printers and real cameras. Run these before relying on
paper counting for an election, and again after changing the layout or the thresholds.

## Set-up

1. Start the demo, which prints four members' ballots (M002 to M005) as PDFs:

   ```
   npm run demo
   ```

   The demo prints where its folder is. Ballots are in its `ballots` folder.
2. Print the four PDFs on the printer you'll use for the election, on plain US Letter paper.
3. Mark them by hand, with a mix of pens (ballpoint, gel, felt tip, pencil) and a mix of mark styles:
   - properly filled ovals
   - half-filled ovals, ticks, crosses and circled ovals
   - a crossed-out mark next to a filled one
   - a write-in, if your rules allow them
   - an overvote, and a ranked contest with a skipped rank

   Write down what each ballot should read.
4. In the tellers' app (`/demo/sign-in/teller`, then the election), receive each ballot by typing its code. Wait for
   voting to close (`DEMO_CLOSE_MINUTES=5 npm run demo` makes the wait short), then sign the close:

   ```
   curl -X POST http://localhost:8787/demo/close
   ```

## Tests

For each method, read all four ballots in the tellers' app (step 2, "Read the paper ballots") and compare with what you
wrote down. The picture shown after each sheet marks what was read: a blue box with a tick for a mark, an amber box
with a triangle for an unclear one.

| Method | How | Pass if |
| --- | --- | --- |
| Phone camera | "Use the camera" on a phone, the sheet flat on a darker table, in normal room light, then again near a window (strong side light) | Every proper fill reads as a mark; ticks, crosses, half fills and circles go to "Rule on unclear ballots"; nothing empty reads as a mark |
| Phone photo upload | Take the photos with the phone's own camera app and choose them as "Scanner images" | Same, and the stored image has no location data (it's re-saved) |
| Home printer's scanner | Scan at 200 dpi, colour and greyscale, then 150 and 300 dpi | Same at every setting |
| Flatbed or sheet feeder | A batch of all sheets in one go, some fed upside down | Same; upside-down sheets read correctly |
| Folded ballots | Fold each sheet in a Z, unfold it, then scan | Creases don't read as marks |

Record for each run: the device, the settings, how many marks read correctly, how many went to a teller, and any mark
read wrongly. A mark read wrongly (a mark missed, or an empty oval read as a mark) is a failure: report it with the
image. Too many sent to a teller is a nuisance, not a failure, but say so.

## If the thresholds need changing

The thresholds are `MARK` in `packages/core/src/scan.ts`: a mark must cover at least 70% of the inside of the oval and
45% of each quarter of it; 12% or less is empty; anything between goes to a teller. Lowering `filled` makes sloppy
fills count without a teller but risks reading crosses as marks; the safe direction is always towards a teller.
