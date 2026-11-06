#!/usr/bin/env bash
# Local end-to-end checks for the Bun & Blaze booking API (wrangler dev).
set -u
B="http://127.0.0.1:8787"
D=$(date +%F)
T=$(date -d tomorrow +%F)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS  $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1  <- $2"; }

echo "== page + assets =="
for p in "/" "/styles.css" "/app.js"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$B$p")
  [ "$code" = "200" ] && ok "GET $p -> 200" || bad "GET $p" "$code"
done
curl -s "$B/" | grep -q 'id="booking-form"' && ok "index markup served" || bad "index markup" "missing form"
curl -s "$B/" | grep -q 'id="office-view"' && ok "back office markup served" || bad "office markup" "missing view"
curl -s "$B/" | grep -q 'id="booking-sheet"' && ok "manager sheet markup served" || bad "sheet markup" "missing dialog"

echo "== availability =="
slots=$(curl -s "$B/api/slots?date=$D")
echo "$slots" | grep -q '"time":"18:00","used":0' && ok "slots return empty seatings" || bad "slots" "$slots"

echo "== create booking =="
R=$(curl -s -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Local Test\",\"phone\":\"5035550100\",\"email\":\"local@example.com\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2,\"occasion\":\"Birthday\",\"notes\":\"window booth\"}")
REF=$(echo "$R" | sed -n 's/.*"ref":"\([^"]*\)".*/\1/p')
ID=$(echo "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
{ [ -n "$REF" ] && [ -n "$ID" ]; } && ok "booking created ($REF)" || bad "create" "$R"
echo "$R" | grep -q '"status":"pending"' && ok "new booking is pending" || bad "new status" "$R"

echo "== validation =="
code=$(curl -s -o /tmp/v1 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"A\",\"phone\":\"1\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects short name/phone (400)" || bad "validation" "$code $(cat /tmp/v1)"
code=$(curl -s -o /tmp/v2 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"$D\",\"time\":\"03:30\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects off-menu time (400)" || bad "time validation" "$code $(cat /tmp/v2)"
code=$(curl -s -o /tmp/v3 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"2020-01-01\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects past date (400)" || bad "date validation" "$code $(cat /tmp/v3)"

echo "== manager auth =="
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/reservations?date=$D")
[ "$code" = "401" ] && ok "board blocked without passcode (401)" || bad "board auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"9999"}')
[ "$code" = "401" ] && ok "wrong passcode rejected (401)" || bad "bad login" "$code"
code=$(curl -s -o /tmp/v4 -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"1234"}')
[ "$code" = "200" ] && ok "correct passcode accepted" || bad "good login" "$code $(cat /tmp/v4)"
board=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234')
echo "$board" | grep -q "$REF" && ok "board shows the new booking" || bad "board content" "$board"

echo "== seat counts + status flow =="
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":2' && ok "availability counts the covers" || bad "cover count" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /tmp/v5 -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"status":"confirmed"}')
[ "$code" = "200" ] && grep -q '"status":"confirmed"' /tmp/v5 && ok "confirm status saved" || bad "patch" "$code $(cat /tmp/v5)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -d '{"status":"confirmed"}')
[ "$code" = "401" ] && ok "status change needs passcode" || bad "patch auth" "$code"

echo "== capacity guard =="
for i in 1 2; do
  curl -s -o /dev/null -X POST "$B/api/reservations" -H 'content-type: application/json' \
    -d "{\"name\":\"Group $i\",\"phone\":\"503555020$i\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}"
done
code=$(curl -s -o /tmp/v6 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Group 3\",\"phone\":\"5035550203\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}")
[ "$code" = "409" ] && ok "third 8-top refused (20-seat cap)" || bad "capacity" "$code $(cat /tmp/v6)"

echo "== customer cancel + shared status =="
code=$(curl -s -o /tmp/v7 -w "%{http_code}" -X POST "$B/api/reservations/$REF/cancel")
[ "$code" = "200" ] && grep -q '"status":"cancelled"' /tmp/v7 && ok "cancel by reference works" || bad "cancel" "$code $(cat /tmp/v7)"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":0' && ok "cancelled covers freed up" || bad "freed seats" "$(curl -s "$B/api/slots?date=$D")"
mine=$(curl -s "$B/api/mine?refs=$REF")
echo "$mine" | grep -q '"ref":"'"$REF"'"' && ok "lookup by reference returns the booking" || bad "mine" "$mine"
echo "$mine" | grep -q '"status":"cancelled"' && ok "lookup reflects the live status" || bad "mine status" "$mine"

echo "== delete (manager only) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID")
[ "$code" = "401" ] && ok "delete needs passcode" || bad "delete auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "manager can delete a booking" || bad "delete" "$code"
if curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -q "$REF"; then bad "deleted row still on board" "$REF"; else ok "deleted booking gone from board"; fi

echo "== seatings + staff edits =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "200" ] && ok "manager can close a seating" || bad "close seating" "$code"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"14:00","used":[0-9]*,"closed":true' && ok "closed flag reaches the site" || bad "closed flag" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Blocked Guest\",\"phone\":\"5035550999\",\"date\":\"$D\",\"time\":\"14:00\",\"party\":2}")
[ "$code" = "409" ] && ok "closed seating refuses online bookings" || bad "closed booking" "$code"
curl -s -o /dev/null -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":false}"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "401" ] && ok "seating control needs passcode" || bad "seating auth" "$code"
code=$(curl -s -o /tmp/staff -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"name\":\"Staff Booking\",\"phone\":\"5035550888\",\"date\":\"$D\",\"time\":\"15:00\",\"party\":3,\"status\":\"confirmed\"}")
[ "$code" = "201" ] && grep -q '"status":"confirmed"' /tmp/staff && ok "manager can add an approved booking" || bad "staff booking" "$code $(cat /tmp/staff)"
SID=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | sed -n 's/.*"id":"\([^"]*\)","ref":"[^"]*","name":"Staff Booking".*/\1/p')
code=$(curl -s -o /tmp/edit -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"party":6,"notes":"edited by the manager"}')
if [ "$code" = "200" ] && grep -q '"party":6' /tmp/edit && grep -q 'edited by the manager' /tmp/edit; then ok "manager can edit party size and notes"; else bad "edit booking" "$code $(cat /tmp/edit)"; fi
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -d '{"party":7}')
[ "$code" = "401" ] && ok "editing needs passcode" || bad "edit auth" "$code"
curl -s -o /dev/null -X DELETE "$B/api/reservations/$SID" -H 'x-manager-code: 1234'

echo "== samples =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/samples" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "sample bookings load" || bad "samples" "$code"
count=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -o '"ref":"BG-SMP' | wc -l)
[ "$count" -ge 1 ] && ok "samples appear on the board ($count today)" || bad "sample rows" "$count"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/demo" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "samples removable" || bad "clear demo" "$code"

echo
B="http://127.0.0.1:8787"
T=$(date -d tomorrow +%F)
sleep 1
echo
B="http://127.0.0.1:8787"
D=$(date +%F)
T=$(date -d tomorrow +%F)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS  $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1  <- $2"; }

echo "== page + assets =="
for p in "/" "/styles.css" "/app.js"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$B$p")
  [ "$code" = "200" ] && ok "GET $p -> 200" || bad "GET $p" "$code"
done
curl -s "$B/" | grep -q 'id="booking-form"' && ok "index markup served" || bad "index markup" "missing form"
curl -s "$B/" | grep -q 'id="office-view"' && ok "back office markup served" || bad "office markup" "missing view"
curl -s "$B/" | grep -q 'id="booking-sheet"' && ok "manager sheet markup served" || bad "sheet markup" "missing dialog"

echo "== availability =="
slots=$(curl -s "$B/api/slots?date=$D")
echo "$slots" | grep -q '"time":"18:00","used":0' && ok "slots return empty seatings" || bad "slots" "$slots"

echo "== create booking =="
R=$(curl -s -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Local Test\",\"phone\":\"5035550100\",\"email\":\"local@example.com\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2,\"occasion\":\"Birthday\",\"notes\":\"window booth\"}")
REF=$(echo "$R" | sed -n 's/.*"ref":"\([^"]*\)".*/\1/p')
ID=$(echo "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
{ [ -n "$REF" ] && [ -n "$ID" ]; } && ok "booking created ($REF)" || bad "create" "$R"
echo "$R" | grep -q '"status":"pending"' && ok "new booking is pending" || bad "new status" "$R"

echo "== validation =="
code=$(curl -s -o /tmp/v1 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"A\",\"phone\":\"1\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects short name/phone (400)" || bad "validation" "$code $(cat /tmp/v1)"
code=$(curl -s -o /tmp/v2 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"$D\",\"time\":\"03:30\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects off-menu time (400)" || bad "time validation" "$code $(cat /tmp/v2)"
code=$(curl -s -o /tmp/v3 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"2020-01-01\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects past date (400)" || bad "date validation" "$code $(cat /tmp/v3)"

echo "== manager auth =="
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/reservations?date=$D")
[ "$code" = "401" ] && ok "board blocked without passcode (401)" || bad "board auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"9999"}')
[ "$code" = "401" ] && ok "wrong passcode rejected (401)" || bad "bad login" "$code"
code=$(curl -s -o /tmp/v4 -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"1234"}')
[ "$code" = "200" ] && ok "correct passcode accepted" || bad "good login" "$code $(cat /tmp/v4)"
board=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234')
echo "$board" | grep -q "$REF" && ok "board shows the new booking" || bad "board content" "$board"

echo "== seat counts + status flow =="
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":2' && ok "availability counts the covers" || bad "cover count" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /tmp/v5 -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"status":"confirmed"}')
[ "$code" = "200" ] && grep -q '"status":"confirmed"' /tmp/v5 && ok "confirm status saved" || bad "patch" "$code $(cat /tmp/v5)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -d '{"status":"confirmed"}')
[ "$code" = "401" ] && ok "status change needs passcode" || bad "patch auth" "$code"

echo "== capacity guard =="
for i in 1 2; do
  curl -s -o /dev/null -X POST "$B/api/reservations" -H 'content-type: application/json' \
    -d "{\"name\":\"Group $i\",\"phone\":\"503555020$i\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}"
done
code=$(curl -s -o /tmp/v6 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Group 3\",\"phone\":\"5035550203\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}")
[ "$code" = "409" ] && ok "third 8-top refused (20-seat cap)" || bad "capacity" "$code $(cat /tmp/v6)"

echo "== customer cancel + shared status =="
code=$(curl -s -o /tmp/v7 -w "%{http_code}" -X POST "$B/api/reservations/$REF/cancel")
[ "$code" = "200" ] && grep -q '"status":"cancelled"' /tmp/v7 && ok "cancel by reference works" || bad "cancel" "$code $(cat /tmp/v7)"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":0' && ok "cancelled covers freed up" || bad "freed seats" "$(curl -s "$B/api/slots?date=$D")"
mine=$(curl -s "$B/api/mine?refs=$REF")
echo "$mine" | grep -q '"ref":"'"$REF"'"' && ok "lookup by reference returns the booking" || bad "mine" "$mine"
echo "$mine" | grep -q '"status":"cancelled"' && ok "lookup reflects the live status" || bad "mine status" "$mine"

echo "== delete (manager only) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID")
[ "$code" = "401" ] && ok "delete needs passcode" || bad "delete auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "manager can delete a booking" || bad "delete" "$code"
if curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -q "$REF"; then bad "deleted row still on board" "$REF"; else ok "deleted booking gone from board"; fi

echo "== seatings + staff edits =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "200" ] && ok "manager can close a seating" || bad "close seating" "$code"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"14:00","used":[0-9]*,"closed":true' && ok "closed flag reaches the site" || bad "closed flag" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Blocked Guest\",\"phone\":\"5035550999\",\"date\":\"$D\",\"time\":\"14:00\",\"party\":2}")
[ "$code" = "409" ] && ok "closed seating refuses online bookings" || bad "closed booking" "$code"
curl -s -o /dev/null -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":false}"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "401" ] && ok "seating control needs passcode" || bad "seating auth" "$code"
code=$(curl -s -o /tmp/staff -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"name\":\"Staff Booking\",\"phone\":\"5035550888\",\"date\":\"$D\",\"time\":\"15:00\",\"party\":3,\"status\":\"confirmed\"}")
[ "$code" = "201" ] && grep -q '"status":"confirmed"' /tmp/staff && ok "manager can add an approved booking" || bad "staff booking" "$code $(cat /tmp/staff)"
SID=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | sed -n 's/.*"id":"\([^"]*\)","ref":"[^"]*","name":"Staff Booking".*/\1/p')
code=$(curl -s -o /tmp/edit -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"party":6,"notes":"edited by the manager"}')
if [ "$code" = "200" ] && grep -q '"party":6' /tmp/edit && grep -q 'edited by the manager' /tmp/edit; then ok "manager can edit party size and notes"; else bad "edit booking" "$code $(cat /tmp/edit)"; fi
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -d '{"party":7}')
[ "$code" = "401" ] && ok "editing needs passcode" || bad "edit auth" "$code"
curl -s -o /dev/null -X DELETE "$B/api/reservations/$SID" -H 'x-manager-code: 1234'

echo "== samples =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/samples" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "sample bookings load" || bad "samples" "$code"
count=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -o '"ref":"BG-SMP' | wc -l)
[ "$count" -ge 1 ] && ok "samples appear on the board ($count today)" || bad "sample rows" "$count"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/demo" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "samples removable" || bad "clear demo" "$code"

echo
B="http://127.0.0.1:8787"
T=$(date -d tomorrow +%F)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS  $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1  <- $2"; }

echo "== page + assets =="
for p in "/" "/styles.css" "/app.js"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$B$p")
  [ "$code" = "200" ] && ok "GET $p -> 200" || bad "GET $p" "$code"
done
curl -s "$B/" | grep -q 'id="booking-form"' && ok "index markup served" || bad "index markup" "missing form"
curl -s "$B/" | grep -q 'id="office-view"' && ok "back office markup served" || bad "office markup" "missing view"
curl -s "$B/" | grep -q 'id="booking-sheet"' && ok "manager sheet markup served" || bad "sheet markup" "missing dialog"

echo "== availability =="
slots=$(curl -s "$B/api/slots?date=$D")
echo "$slots" | grep -q '"time":"18:00","used":0' && ok "slots return empty seatings" || bad "slots" "$slots"

echo "== create booking =="
R=$(curl -s -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Local Test\",\"phone\":\"5035550100\",\"email\":\"local@example.com\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2,\"occasion\":\"Birthday\",\"notes\":\"window booth\"}")
REF=$(echo "$R" | sed -n 's/.*"ref":"\([^"]*\)".*/\1/p')
ID=$(echo "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
{ [ -n "$REF" ] && [ -n "$ID" ]; } && ok "booking created ($REF)" || bad "create" "$R"
echo "$R" | grep -q '"status":"pending"' && ok "new booking is pending" || bad "new status" "$R"

echo "== validation =="
code=$(curl -s -o /tmp/v1 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"A\",\"phone\":\"1\",\"date\":\"$D\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects short name/phone (400)" || bad "validation" "$code $(cat /tmp/v1)"
code=$(curl -s -o /tmp/v2 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"$D\",\"time\":\"03:30\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects off-menu time (400)" || bad "time validation" "$code $(cat /tmp/v2)"
code=$(curl -s -o /tmp/v3 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Valid Name\",\"phone\":\"5035550101\",\"date\":\"2020-01-01\",\"time\":\"18:00\",\"party\":2}")
[ "$code" = "400" ] && ok "rejects past date (400)" || bad "date validation" "$code $(cat /tmp/v3)"

echo "== manager auth =="
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/reservations?date=$D")
[ "$code" = "401" ] && ok "board blocked without passcode (401)" || bad "board auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"9999"}')
[ "$code" = "401" ] && ok "wrong passcode rejected (401)" || bad "bad login" "$code"
code=$(curl -s -o /tmp/v4 -w "%{http_code}" -X POST "$B/api/manager/login" -H 'content-type: application/json' -d '{"code":"1234"}')
[ "$code" = "200" ] && ok "correct passcode accepted" || bad "good login" "$code $(cat /tmp/v4)"
board=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234')
echo "$board" | grep -q "$REF" && ok "board shows the new booking" || bad "board content" "$board"

echo "== seat counts + status flow =="
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":2' && ok "availability counts the covers" || bad "cover count" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /tmp/v5 -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"status":"confirmed"}')
[ "$code" = "200" ] && grep -q '"status":"confirmed"' /tmp/v5 && ok "confirm status saved" || bad "patch" "$code $(cat /tmp/v5)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$ID" -H 'content-type: application/json' -d '{"status":"confirmed"}')
[ "$code" = "401" ] && ok "status change needs passcode" || bad "patch auth" "$code"

echo "== capacity guard =="
for i in 1 2; do
  curl -s -o /dev/null -X POST "$B/api/reservations" -H 'content-type: application/json' \
    -d "{\"name\":\"Group $i\",\"phone\":\"503555020$i\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}"
done
code=$(curl -s -o /tmp/v6 -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' \
  -d "{\"name\":\"Group 3\",\"phone\":\"5035550203\",\"date\":\"$T\",\"time\":\"19:00\",\"party\":8}")
[ "$code" = "409" ] && ok "third 8-top refused (20-seat cap)" || bad "capacity" "$code $(cat /tmp/v6)"

echo "== customer cancel + shared status =="
code=$(curl -s -o /tmp/v7 -w "%{http_code}" -X POST "$B/api/reservations/$REF/cancel")
[ "$code" = "200" ] && grep -q '"status":"cancelled"' /tmp/v7 && ok "cancel by reference works" || bad "cancel" "$code $(cat /tmp/v7)"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"18:00","used":0' && ok "cancelled covers freed up" || bad "freed seats" "$(curl -s "$B/api/slots?date=$D")"
mine=$(curl -s "$B/api/mine?refs=$REF")
echo "$mine" | grep -q '"ref":"'"$REF"'"' && ok "lookup by reference returns the booking" || bad "mine" "$mine"
echo "$mine" | grep -q '"status":"cancelled"' && ok "lookup reflects the live status" || bad "mine status" "$mine"

echo "== delete (manager only) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID")
[ "$code" = "401" ] && ok "delete needs passcode" || bad "delete auth" "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/reservations/$ID" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "manager can delete a booking" || bad "delete" "$code"
if curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -q "$REF"; then bad "deleted row still on board" "$REF"; else ok "deleted booking gone from board"; fi

echo "== seatings + staff edits =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "200" ] && ok "manager can close a seating" || bad "close seating" "$code"
curl -s "$B/api/slots?date=$D" | grep -q '"time":"14:00","used":[0-9]*,"closed":true' && ok "closed flag reaches the site" || bad "closed flag" "$(curl -s "$B/api/slots?date=$D")"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -d "{\"name\":\"Blocked Guest\",\"phone\":\"5035550999\",\"date\":\"$D\",\"time\":\"14:00\",\"party\":2}")
[ "$code" = "409" ] && ok "closed seating refuses online bookings" || bad "closed booking" "$code"
curl -s -o /dev/null -X POST "$B/api/seating" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":false}"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/seating" -H 'content-type: application/json' -d "{\"date\":\"$D\",\"time\":\"14:00\",\"closed\":true}")
[ "$code" = "401" ] && ok "seating control needs passcode" || bad "seating auth" "$code"
code=$(curl -s -o /tmp/staff -w "%{http_code}" -X POST "$B/api/reservations" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d "{\"name\":\"Staff Booking\",\"phone\":\"5035550888\",\"date\":\"$D\",\"time\":\"15:00\",\"party\":3,\"status\":\"confirmed\"}")
[ "$code" = "201" ] && grep -q '"status":"confirmed"' /tmp/staff && ok "manager can add an approved booking" || bad "staff booking" "$code $(cat /tmp/staff)"
SID=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | sed -n 's/.*"id":"\([^"]*\)","ref":"[^"]*","name":"Staff Booking".*/\1/p')
code=$(curl -s -o /tmp/edit -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -H 'x-manager-code: 1234' -d '{"party":6,"notes":"edited by the manager"}')
if [ "$code" = "200" ] && grep -q '"party":6' /tmp/edit && grep -q 'edited by the manager' /tmp/edit; then ok "manager can edit party size and notes"; else bad "edit booking" "$code $(cat /tmp/edit)"; fi
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$B/api/reservations/$SID" -H 'content-type: application/json' -d '{"party":7}')
[ "$code" = "401" ] && ok "editing needs passcode" || bad "edit auth" "$code"
curl -s -o /dev/null -X DELETE "$B/api/reservations/$SID" -H 'x-manager-code: 1234'

echo "== samples =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/samples" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "sample bookings load" || bad "samples" "$code"
count=$(curl -s "$B/api/reservations?date=$D" -H 'x-manager-code: 1234' | grep -o '"ref":"BG-SMP' | wc -l)
[ "$count" -ge 1 ] && ok "samples appear on the board ($count today)" || bad "sample rows" "$count"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/api/demo" -H 'x-manager-code: 1234')
[ "$code" = "200" ] && ok "samples removable" || bad "clear demo" "$code"

echo "RESULT: $pass passed, $fail failed"