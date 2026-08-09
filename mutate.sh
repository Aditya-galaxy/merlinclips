#!/usr/bin/env bash
#
# Mutation testing: break one guard on purpose, run the suite, put it back.
#
# A passing suite says the code does what the tests check. It does not say the
# tests check what matters. This does: if a control can be deleted and every
# test still passes, that control is asserted in prose and enforced by nothing.
#
# This found three real gaps on its first run, all in views.ts — the dwell
# cutoff boundary, the hasDwelled boundary, and the malformed-timestamp skip
# whose safety property existed only as a comment. Each could have been flipped
# by a later refactor with the suite staying green.
#
#   ./mutate.sh            run the catalogue
#   ./mutate.sh --list     show the mutants without running them
#
# A SURVIVED line is a finding. Two honest caveats:
#
#   * Some mutants are *equivalent* — they change the source without changing
#     behaviour, so no test can catch them and none should. views.ts's
#     anchor-loop NaN guard is one: NaN comparisons are already false, so the
#     guard is redundant there. Check before writing a test to chase one.
#   * A timing-safe comparison mutated into an early-return will always
#     survive. Tests cannot observe wall-clock leaks. That is a limit of the
#     method, not a defect in the suite.
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"

# file :: original :: replacement :: label
MUTANTS=(
  "src/policy.ts::if (s.killSwitch) {::if (false && s.killSwitch) {::I4  kill switch admits no exceptions"
  "src/policy.ts::if (amount.gt(s.absoluteMaxPerPaymentUsdc)) {::if (false && amount.gt(s.absoluteMaxPerPaymentUsdc)) {::I1  absolute per-payment ceiling"
  "src/policy.ts::if (!isTestnet(intent.chain) && !s.allowMainnet) {::if (false) {::I20 mainnet guard"
  "src/policy.ts::if (amount.gt(mandate.maxPerPaymentUsdc)) {::if (false) {::I2  mandate per-payment cap"
  "src/policy.ts::if (after.gt(cap)) {::if (false) {::I6  rolling window cap"
  "src/campaign/payout.ts::if (!verdict.pass) {::if (false) {::I15 no payout without a passing verdict"
  "src/campaign/payout.ts::if (termsExpired(terms, now)) {::if (false) {::I11 settlement deadline binds"
  "src/campaign/payout.ts::if (spent.plus(amount).gt(campaign.poolUsdc)) {::if (false) {::I12 pool ceiling"
  "src/campaign/views.ts::if (snapshot.views < confirmed) confirmed = snapshot.views;::if (false) confirmed = snapshot.views;::window minimum (scrub-and-rebuy)"
  "src/campaign/views.ts::return delta > 0n ? delta : 0n;::return delta;::I16 payable never negative"
  "src/campaign/views.ts::if (atMs <= cutoff && atMs > latestAgedMs) {::if (atMs < cutoff && atMs > latestAgedMs) {::dwell cutoff boundary"
  "src/campaign/views.ts::return !Number.isNaN(atMs) && atMs <= cutoff;::return !Number.isNaN(atMs) && atMs < cutoff;::hasDwelled boundary"
  "src/campaign/agent.ts::const finding: Finding = raw === 'clear' || raw === 'hold' ? raw : 'watch';::const finding: Finding = (raw || 'clear') as Finding;::I21 unrecognised verdict must not clear"
  "src/campaign/lease.ts::if (won) return { acquired: true, key };::return { acquired: true, key };::cross-instance lease excludes"
  "src/campaign/runtime.ts::const expected = this.env.OPERATOR_SECRET;::const expected = this.env.OPERATOR_SECRET ?? 'x';::operator gate fails closed"
  "src/campaign/runtime.ts::if (this.inFlightTick) return this.inFlightTick;::if (false) return this.inFlightTick;::single-flight within a process"
  "src/campaign/intake.ts::dwellHours < MIN_DWELL_HOURS::dwellHours < 0::dwell floor cannot be bypassed"
)

if [ "${1:-}" = "--list" ]; then
  for m in "${MUTANTS[@]}"; do echo "  ${m##*::}"; done
  exit 0
fi

survived=0
skipped=0
echo "Mutation testing — ${#MUTANTS[@]} guards, each broken then restored."
echo

for m in "${MUTANTS[@]}"; do
  FILE="${m%%::*}"; rest="${m#*::}"
  FROM="${rest%%::*}"; rest="${rest#*::}"
  TO="${rest%%::*}"; LABEL="${rest#*::}"

  cp "$FILE" "$FILE.mutorig"
  if ! python3 - "$FILE" "$FROM" "$TO" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
if sys.argv[2] not in s: sys.exit(9)
p.write_text(s.replace(sys.argv[2], sys.argv[3], 1))
PY
  then
    mv "$FILE.mutorig" "$FILE"
    printf "  %-50s SKIP (pattern moved — update the catalogue)\n" "$LABEL"
    skipped=$((skipped + 1))
    continue
  fi

  bun test >/dev/null 2>&1; code=$?
  mv "$FILE.mutorig" "$FILE"

  if [ $code -ne 0 ]; then
    printf "  %-50s caught\n" "$LABEL"
  else
    printf "  %-50s *** SURVIVED ***\n" "$LABEL"
    survived=$((survived + 1))
  fi
done

echo
echo "$survived survived, $skipped skipped, $(( ${#MUTANTS[@]} - survived - skipped )) caught"
# Non-zero on a survivor so this is usable as a gate, and on a skip so a moved
# guard cannot silently stop being checked.
[ $survived -eq 0 ] && [ $skipped -eq 0 ]
