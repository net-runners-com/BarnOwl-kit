#!/usr/bin/env python3
"""Free image generation via Codex CLI (ChatGPT Plus). Supports reference image editing."""
import os, sys, shutil, subprocess
from datetime import datetime

def get_codex_bin():
    if sys.platform == "win32":
        # Windows default installation path
        return os.path.expandvars(r"%LOCALAPPDATA%\Programs\codex\codex.exe")
    else:
        # macOS default installation path
        return "/Applications/Codex.app/Contents/Resources/codex"

CODEX_BIN = os.environ.get("CODEX_BIN", get_codex_bin())
GEN_DIR = os.path.expanduser("~/.codex/generated_images")


def list_images():
    imgs = []
    if os.path.isdir(GEN_DIR):
        for root, _, files in os.walk(GEN_DIR):
            for f in files:
                if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                    fp = os.path.join(root, f)
                    imgs.append((fp, os.path.getmtime(fp)))
    return imgs


def generate(prompt, size="1024x1024", output_dir=None, image=None, model=None, quality=None):
    # barnowl: general-purpose quality template (upstream's was infographic-only)
    hd = " Ultra-high detail." if quality in ("hd", "high") else ""
    if image:
        full_prompt = f"I have an existing image at {image}. Please reference its design style and layout, but regenerate it based on the following description: {prompt}. Image size {size}.{hd}"
    else:
        full_prompt = f"Generate an image: {prompt}. Image size {size}. Render any text in the image accurately and legibly.{hd}"

    print(f"Generating: {prompt[:80]}...", file=sys.stderr)

    before = {fp for fp, _ in list_images()}

    # barnowl: run codex clean — no user-config MCP servers (they add minutes of
    # startup), no session files, no color codes. image_generation is a stable
    # default feature so it stays available without user config.
    cmd = [CODEX_BIN, "exec", full_prompt, "--skip-git-repo-check",
           "--ignore-user-config", "--ephemeral", "--color", "never"]
    if model:  # barnowl: per-request model routing (e.g. gpt-5.6-sol)
        cmd += ["-m", model]

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=900,
        env={**os.environ, "HOME": os.environ.get("HOME", os.path.expanduser("~"))},
    )

    if result.returncode != 0:
        raise Exception(f"codex failed (exit={result.returncode})")

    after = list_images()
    new_imgs = [(fp, mt) for fp, mt in after if fp not in before]
    if not new_imgs:
        raise Exception("No new image found")

    new_imgs.sort(key=lambda x: x[1], reverse=True)
    image_path = new_imgs[0][0]

    output_dir = output_dir or os.getcwd()
    ext = os.path.splitext(image_path)[1] or ".png"
    filename = f"codex-image-{datetime.now().strftime('%Y%m%d-%H%M%S')}{ext}"
    dest = os.path.join(output_dir, filename)
    shutil.copy2(image_path, dest)
    return dest


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate.py '<prompt>' [size] [output_dir] [--image <path>]")
        sys.exit(1)

    prompt = sys.argv[1]
    size = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "1024x1024"
    output_dir = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else os.getcwd()
    image = None
    if "--image" in sys.argv:
        idx = sys.argv.index("--image")
        if idx + 1 < len(sys.argv):
            image = sys.argv[idx + 1]
    model = None  # barnowl: --model passthrough
    if "--model" in sys.argv:
        idx = sys.argv.index("--model")
        if idx + 1 < len(sys.argv):
            model = sys.argv[idx + 1]
    quality = None  # barnowl: --quality standard|hd
    if "--quality" in sys.argv:
        idx = sys.argv.index("--quality")
        if idx + 1 < len(sys.argv):
            quality = sys.argv[idx + 1]

    try:
        path = generate(prompt, size, output_dir, image, model, quality)
        print(f"SUCCESS:{path}")
    except Exception as e:
        print(f"ERROR:{e}")
        sys.exit(1)
