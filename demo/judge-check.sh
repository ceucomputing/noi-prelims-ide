#!/bin/sh
# Runs each of the demo's solutions on every test of its task, with the judge's compiler and Python.
#
# It runs them in a Docker container with g++ 9.4 and Python 3.8 on Ubuntu 20.04, like the judge. The
# container is built from judge/Dockerfile.
#
# Usage, after node demo/fetch.mjs:  sh demo/judge-check.sh
set -e

docker build --quiet --tag noi-ref-judge judge > /dev/null

work=$(mktemp -d)
unzip -q downloads/noi/noi-2026-prelim.zip -d "$work"
mv "$work"/noi-2026-prelim-*/* "$work"/

# List the solutions as "task file" lines, from each task's task.json.
node -e '
  const fs = require("fs");
  for (const task of fs.readFileSync("demo/tasks.txt", "utf8").split(/\s+/).filter(Boolean)) {
    for (const file of Object.values(require(`./demo/${task}/task.json`).solutions)) {
      console.log(task, file);
    }
  }
' > "$work/solutions"

# This script runs inside the container.
cat > "$work/run.sh" <<'SCRIPT'
ulimit -s unlimited
cd /w

# Compare two files, ignoring differences in whitespace.
same() {
  [ "$(tr -s ' \r\n\t' '\n' < "$1" | sed '/^$/d')" = "$(tr -s ' \r\n\t' '\n' < "$2" | sed '/^$/d')" ]
}

while read -r task file; do
  case $file in
    *.cpp)
      if ! g++ -DEVAL -std=gnu++17 -O2 -pipe -static -s -o /tmp/solution "$file" 2>/dev/null; then
        echo "$file: compile error"
        continue
      fi
      command=/tmp/solution
      ;;
    *.py)
      command="python3 $file"
      ;;
  esac

  passed=0
  failed=0
  for input in "$task"/tests/*.in; do
    if timeout 10 $command < "$input" > /tmp/output 2>/dev/null && same /tmp/output "${input%.in}.out"; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
      echo "  FAIL $input"
    fi
  done
  echo "$file: $passed of $((passed + failed)) tests pass"
done < solutions
SCRIPT

docker run --rm -v "$work:/w" noi-ref-judge sh /w/run.sh
rm -rf "$work"
