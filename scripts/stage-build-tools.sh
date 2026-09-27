#!/usr/bin/env bash
# 在 ubuntu-24.04-arm runner 上把「编译工具」组件组预置成与 rootfs 同构的目录树。
#
#   stage-build-tools.sh <目标目录> [ubuntu-base 归档] [包清单输出路径]
#
# 与 scripts/stage-network-tools.sh 同构但独立成组，理由有三：
#   * 体积量级不同：编译器 + 头文件约两百 MB，网络组件约 4 MB，
#     共用 96 MB 上限一方必然误伤另一方；
#   * 开关独立：`--without-build-tools` 只关编译器，不影响 git/curl；
#   * 路径形态不同：这里没有需要硬链接去重的 git-core，也没有 CA 信任库要重建。
#
# 包选择（刻意最小可用，不是 build-essential）：
#   gcc / g++ / make / libc6-dev / libstdc++-dev / pkg-config / binutils。
#   - g++ 在列：node-gyp 等原生模块绝大多数是 C++，缺 g++ 等于白装；
#   - perl 系（build-essential 拖进来的 dpkg-dev 等）不在列：与网络组件一致，
#     镜像里不跑 apt，不需要打包工具链；
#   - Go / Rust / JDK 不在这里：它们是数百 MB 到 GB 量级，走按需 toolpack，
#     永不烘焙进整包。
#
# 文件枚举用 `dpkg -L` 而不是手写路径：gcc-13/14、aarch64-linux-gnu- 前缀等
# 版本相关名字由包管理器自己报，Ubuntu 小版本升级不会让清单过期。
# 只保留编码相关的前缀，文档/man/locale/info 与静态库（.a，走 -static 的小众需求）丢弃。
#
# 包清单用于 scripts/legal-notices.py collect：每个落进镜像的文件由哪个包提供
# （dpkg -S 反查），据此收集发行版版权文件，传递依赖库也不会漏登记。
set -euo pipefail

DEST="${1:?用法: stage-build-tools.sh <目标目录> [ubuntu-base 归档] [包清单输出路径]}"
BASE_ARCHIVE="${2:-}"
PACKAGE_LIST="${3:-${DEST%/}-packages.txt}"

log() { printf '[stage-build-tools] %s\n' "$*"; }

# ---- 1. 在 runner 上安装组件（不在镜像里跑 apt）--------------------------------
PACKAGES=(gcc g++ make libc6-dev libstdc++-dev pkg-config binutils)
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends "${PACKAGES[@]}"
log "已安装: ${PACKAGES[*]}"

# ---- 2. 基线镜像已有路径（过滤掉，避免 rootfs 重复条目）------------------------
BASE_PATHS="$(mktemp)"
ALL_ENTRIES="$(mktemp)"
COPY_LIST="$(mktemp)"
NEW_LIBS="$(mktemp)"
STAGED_PATHS="$(mktemp)"
trap 'rm -f "$BASE_PATHS" "$ALL_ENTRIES" "$COPY_LIST" "$NEW_LIBS" "$NEW_LIBS.filtered" "$STAGED_PATHS"' EXIT
if [[ -n "$BASE_ARCHIVE" && -f "$BASE_ARCHIVE" ]]; then
  # 与 stage-network-tools.sh 同一条注释同样适用：tar 列出的是 `./usr/…` 或
  # `usr/…`，候选清单是绝对路径，写法不归一 `comm` 就永远不匹配，过滤等于没做。
  tar -tzf "$BASE_ARCHIVE" | sed 's:/$::; s:^\./::; s:^:/:' | LC_ALL=C sort -u > "$BASE_PATHS"
  log "基线镜像路径数: $(wc -l < "$BASE_PATHS")"
else
  : > "$BASE_PATHS"
  log "警告: 未提供 ubuntu-base 归档，无法过滤基线镜像已有路径"
fi

# ---- 3. 候选源路径：dpkg 枚举 + 前缀白名单 -------------------------------------
# 保留：编译驱动与工具（/usr/bin）、编译器内部件（/usr/lib/gcc）、
# 头文件（/usr/include 及其多架构变体）、C 运行时启动对象（crt*.o，
# ldd 看不见它们，必须显式带）与共享库（交由第 5 步闭包补全，这里先收网）。
# 丢弃：文档/man/locale/info、静态库（.a）、其它一切。
collect_owned_paths() {
  local pkg owned
  for pkg in "${PACKAGES[@]}"; do
    while IFS= read -r owned; do
      [[ -n "$owned" ]] || continue
      case "$owned" in
        /usr/share/doc/*|/usr/share/man/*|/usr/share/locale/*|/usr/share/info/*|/usr/share/lintian/*)
          continue
          ;;
        *.a)
          continue
          ;;
        /usr/bin/*|/usr/lib/gcc/*|/usr/include/*|/usr/*/include/*|/usr/lib/*/crt*.o|/usr/lib/*/*.so*)
          printf '%s\n' "$owned"
          ;;
      esac
    done < <(dpkg -L "$pkg" 2>/dev/null)
  done
}

enumerate_entries() {
  local source entry
  for source in "$@"; do
    if [[ -d "$source" && ! -L "$source" ]]; then
      while IFS= read -r entry; do
        printf '%s\n' "$entry"
      done < <(find "$source" \( -type f -o -type l \) -print)
    elif [[ -e "$source" || -L "$source" ]]; then
      printf '%s\n' "$source"
    else
      log "跳过不存在的路径: $source"
    fi
  done
}

mapfile -t OWNED_PATHS < <(collect_owned_paths | LC_ALL=C sort -u)
if ((${#OWNED_PATHS[@]} == 0)); then
  echo "包枚举为空：dpkg 未报出任何可用路径，拒绝产出空组件" >&2
  exit 1
fi
log "包拥有且命中白名单的路径: ${#OWNED_PATHS[@]} 条"
enumerate_entries "${OWNED_PATHS[@]}" | sed 's:/$::' | LC_ALL=C sort -u > "$ALL_ENTRIES"
LC_ALL=C comm -23 "$ALL_ENTRIES" "$BASE_PATHS" > "$COPY_LIST"
log "候选条目: $(wc -l < "$ALL_ENTRIES")，去掉基线镜像已有后: $(wc -l < "$COPY_LIST")"

# ---- 4. 一次性复制 -------------------------------------------------------------
mkdir -p "$DEST"
if [[ -s "$COPY_LIST" ]]; then
  mapfile -t COPY_PATHS < "$COPY_LIST"
  cp -a --parents "${COPY_PATHS[@]}" "$DEST/"
  cat "$COPY_LIST" >> "$STAGED_PATHS"
fi

# ---- 5. 共享库传递闭包（ldd 优先、readelf 兜底，与网络组件同一套教训） ---------
# O-7 的根因在这里同样成立：只看二进制存在与否不看依赖，libmpfr/libmpc/libgmp
# 缺一个，访客里 gcc 启动即死，而所有存在性校验全绿。闭包逻辑与
# stage-network-tools.sh 第 5 步一致（5 轮收敛 + usr-merge 归一化 + 熔断）。
LIBDEPS_METHOD_COUNTS=""
collect_lib_paths() {
  local binary="$1" lib soname resolved
  local via_ldd=0 via_readelf=0
  while IFS= read -r lib; do
    [[ -n "$lib" ]] || continue
    via_ldd=$((via_ldd + 1))
    printf '%s\n' "$lib"
  done < <(ldd "$binary" 2>/dev/null | awk '/=>/ {print $3} !/=>/ && /^\// {print $1}')
  if [[ "$via_ldd" == "0" ]]; then
    while IFS= read -r soname; do
      [[ -n "$soname" ]] || continue
      resolved="$( { ldconfig -p 2>/dev/null || true; } | awk -v s="$soname" '$1 == s {print $NF; exit}')"
      [[ -n "$resolved" ]] || continue
      via_readelf=$((via_readelf + 1))
      printf '%s\n' "$resolved"
    done < <(readelf -d "$binary" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')
  fi
  LIBDEPS_METHOD_COUNTS="${LIBDEPS_METHOD_COUNTS}${via_ldd}/${via_readelf} "
}

usr_merge_path() {
  case "$1" in
    /lib) printf '%s\n' /usr/lib ;;
    /lib/*) printf '%s\n' "/usr/lib/${1#/lib/}" ;;
    /bin) printf '%s\n' /usr/bin ;;
    /bin/*) printf '%s\n' "/usr/bin/${1#/bin/}" ;;
    /sbin) printf '%s\n' /usr/sbin ;;
    /sbin/*) printf '%s\n' "/usr/sbin/${1#/sbin/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
TOTAL_LIBS_COLLECTED=0
for _round in 1 2 3 4 5; do
  : > "$NEW_LIBS"
  while IFS= read -r -d '' binary; do
    while IFS= read -r lib; do
      [[ -n "$lib" && -e "$lib" ]] || continue
      for candidate in "$lib" "$(readlink -f "$lib" 2>/dev/null || true)"; do
        [[ -n "$candidate" && -e "$candidate" ]] || continue
        candidate="$(usr_merge_path "$candidate")"
        [[ -e "$DEST/${candidate#/}" ]] && continue
        printf '%s\n' "$candidate"
      done
    done < <(collect_lib_paths "$binary")
  done < <(find "$DEST" -type f -print0) > "$NEW_LIBS"
  LC_ALL=C sort -u -o "$NEW_LIBS" "$NEW_LIBS"
  LC_ALL=C comm -23 "$NEW_LIBS" "$BASE_PATHS" > "$NEW_LIBS.filtered"
  if [[ ! -s "$NEW_LIBS.filtered" ]]; then
    break
  fi
  mapfile -t ROUND_LIBS < "$NEW_LIBS.filtered"
  cp -a --parents "${ROUND_LIBS[@]}" "$DEST/"
  printf '%s\n' "${ROUND_LIBS[@]}" >> "$STAGED_PATHS"
  TOTAL_LIBS_COLLECTED=$((TOTAL_LIBS_COLLECTED + ${#ROUND_LIBS[@]}))
  log "第 ${_round} 轮补齐共享库: ${#ROUND_LIBS[@]} 个（各二进制的 ldd/readelf 命中数: ${LIBDEPS_METHOD_COUNTS}）"
done

if ((TOTAL_LIBS_COLLECTED == 0)); then
  echo "共享库闭包为空：ldd 与 readelf 都没取到依赖，拒绝产出一个跑不起来的组件组" >&2
  exit 1
fi

# ---- 5b. 反查提供这些文件的包（供法律材料收集使用）-----------------------------
if [[ -s "$STAGED_PATHS" ]]; then
  mapfile -t STAGED_ARRAY < <(LC_ALL=C sort -u "$STAGED_PATHS")
  # 与网络组件脚本同一条 pipefail 教训：dpkg -S 对未登记路径返回非零，
  # 必须显式 `|| true`，否则脚本无声终止。
  log "反查包清单: $(wc -l < "$STAGED_PATHS") 条路径"
  { dpkg -S "${STAGED_ARRAY[@]}" 2>/dev/null || true; } \
    | awk -F': ' '{print $1}' \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | grep -v '^$' \
    | LC_ALL=C sort -u > "$PACKAGE_LIST"
  log "包清单: $(wc -l < "$PACKAGE_LIST") 个包 -> $PACKAGE_LIST"
fi

# ---- 6. 失败即失败：必需文件与悬空链接 ------------------------------------------
require_file() {
  [[ -f "$DEST/${1#/}" ]] || { echo "缺少必需文件: $1" >&2; exit 1; }
}
require_file usr/bin/gcc
require_file usr/bin/g++
require_file usr/bin/make
require_file usr/bin/pkg-config
# 用 -xtype l 而非 -L -type l（与网络组件同一条 EACCES 教训），
# 判定口径同样按最终 rootfs 语义：映射到 usr/ 下再分别在本树与基线清单里找目标。
BROKEN_LINK=""
while IFS= read -r link; do
  rel="${link#"$DEST"/}"
  dir="$(dirname "$rel")"
  case "$dir" in
    lib|bin|sbin|lib/*|bin/*|sbin/*) mapped="usr/$dir" ;;
    *) mapped="$dir" ;;
  esac
  target="$(readlink "$link" 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    BROKEN_LINK="$link"
    break
  fi
  if [[ "$target" == /* ]]; then
    candidate="${target#/}"
  else
    candidate="$mapped/$target"
  fi
  if [[ -e "$DEST/$candidate" ]] || grep -qxF "/$candidate" "$BASE_PATHS"; then
    continue
  fi
  BROKEN_LINK="$link"
  break
done < <(find "$DEST" -xtype l)
if [[ -n "$BROKEN_LINK" ]]; then
  echo "预置树存在悬空符号链接（目标既不在本树也不在基线镜像里）: $BROKEN_LINK" >&2
  exit 1
fi

# 预置的编译器必须真能运行（同架构 runner 上直接跑）：能执行是最基本的闭包正确性证据。
STAGED_GCC="$("$DEST/usr/bin/gcc" --version | head -n1)"
STAGED_MAKE="$("$DEST/usr/bin/make" --version | head -n1)"
log "预置结果: ${STAGED_GCC} / ${STAGED_MAKE}"

# 体积口径
APPARENT_BYTES="$(find "$DEST" -type f -printf '%s\n' | awk '{total += $1} END {print total + 0}')"
log "文件数=$(find "$DEST" -type f | wc -l) 链接数=$(find "$DEST" -type l | wc -l) 表观字节=${APPARENT_BYTES} 磁盘字节=$(du -sb "$DEST" | cut -f1)"
du -sh "$DEST"
