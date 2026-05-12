#!/usr/bin/env bash
set -euo pipefail

SRC_ROOT="${SRC_ROOT:-$HOME/Documents/GitHub/my_app}"
DST_ROOT="${DST_ROOT:-$HOME/Documents/GitHub/kkh975.github.io}"

APPS=(
  app_english_grammar
  app_english_idiom
  app_foreign_writing
  app_frash_card_memory
  app_hanja_learn
  app_habit_manager
  app_stuff_manager
  app_plan_advisor
  app_household_ledger
  app_love_advisor
)

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    printf '[%s] synced %s -> %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$src" "$dst"
  fi
}

sync_all() {
  local app src_doc dst_app
  for app in "${APPS[@]}"; do
    src_doc="$SRC_ROOT/$app/doc"
    dst_app="$DST_ROOT/$app"

    copy_if_exists "$src_doc/privacy_policy.md" "$dst_app/privacy_policy.md"
    copy_if_exists "$src_doc/terms_of_use.md" "$dst_app/terms_of_use.md"

    if [[ -f "$src_doc/introduce.html" ]]; then
      copy_if_exists "$src_doc/introduce.html" "$dst_app/index.html"
    else
      copy_if_exists "$src_doc/index.html" "$dst_app/index.html"
    fi
  done
}

sync_all
