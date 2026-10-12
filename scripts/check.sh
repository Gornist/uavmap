#!/bin/sh
# Единая проверка: типы + линтер + тесты. Печатает короткий вердикт, полный лог — в файл.
LOG="${TMPDIR:-/tmp}/uavmap-check.log"
: > "$LOG"
fail=0
step() {
  name="$1"; shift
  echo "=== $name" >> "$LOG"
  if "$@" >> "$LOG" 2>&1; then echo "✓ $name"; else echo "✗ $name"; fail=1; fi
}
step "типы (tsc)" npx tsc --noEmit
step "линтер (eslint)" npx eslint src
step "тесты (vitest)" npx vitest run --reporter=dot
if [ $fail -ne 0 ]; then
  echo "ПРОВАЛ — подробности: $LOG"
  grep -E "error|✗|FAIL|×" "$LOG" | head -15
  exit 1
fi
echo "ОК"
