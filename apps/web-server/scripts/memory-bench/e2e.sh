#!/bin/zsh
# Drives Memorize end to end through the real server for one gateway leg.
# Usage: ./e2e.sh <leg> [roomId]
set -u
LIVE="$(cd "$(dirname "$0")" && pwd)"
PORT=8951; GW=8952
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
H=(-H "X-Exxperts-Auth: $TOKEN" -H "content-type: application/json" -H "Origin: http://localhost:$PORT")
LEG="$1"; ROOM="${2:-bench-$LEG}"
curl -s -X POST "http://127.0.0.1:$GW/control/leg" -d "{\"leg\":\"$LEG\"}"
# Seed the room (idempotent: 409 if it exists) and write the synthetic memory.
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/persistent-agents" -d "{\"displayName\":\"$ROOM\",\"user\":{\"displayName\":\"Bench User\"}}" > /dev/null
ID=$(curl -s "${H[@]}" "http://localhost:$PORT/api/persistent-agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.agents??j).find(x=>x.displayName===process.argv[1]);console.log(a?a.id:"")})' "$ROOM")
[ -z "$ID" ] && { echo "room not found"; exit 1; }
L1B="$LIVE/home/.exxperts/app/personalized-agents/$ID/L1b/current.md"
cp "$LIVE/synthetic-66k.md" "$L1B"
echo "room=$ID leg=$LEG l1b_bytes=$(wc -c < "$L1B")"
t0=$(date +%s)
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/persistent-agents/$ID/absorb/assess" -d '{}' -o "$LIVE/out-$LEG-assess.json" -w "assess http=%{http_code} time=%{time_total}s\n"
node -e 'const j=require(process.argv[1]);console.log("assess:", j.error? "ERROR: "+j.error.slice(0,300) : "ok warnings="+JSON.stringify(j.warnings))' "$LIVE/out-$LEG-assess.json"
ASSESS=$(node -e 'const j=require(process.argv[1]);process.stdout.write(JSON.stringify(j.assessmentMarkdown??""))' "$LIVE/out-$LEG-assess.json")
[ "$ASSESS" = '""' ] && { echo "no assessment; stop"; exit 0; }
curl -s "${H[@]}" -X POST "http://localhost:$PORT/api/persistent-agents/$ID/absorb/propose" -d "{\"assessmentMarkdown\":$ASSESS}" -o "$LIVE/out-$LEG-propose.json" -w "propose http=%{http_code} time=%{time_total}s\n"
node -e 'const j=require(process.argv[1]);if(j.error){console.log("propose: ERROR:", j.error.slice(0,400));process.exit(0)}const issues=[...(j.candidateValidation.valid?[]:j.candidateValidation.errors),...j.warnings.filter(w=>w.startsWith("proposal "))];console.log("propose: valid="+j.candidateValidation.valid+" issues="+issues.length+" overBudgetAfter="+j.memoryBudgetImpact.overBudgetAfter+" after="+j.memoryBudgetImpact.reviewTargetEstimatedTokensAfter+" usage="+JSON.stringify(j.absorbUsage));for(const i of issues)console.log("   ·",i)' "$LIVE/out-$LEG-propose.json"
echo "total=$(( $(date +%s) - t0 ))s"
tail -1 "$LIVE/gateway-requests.jsonl"
