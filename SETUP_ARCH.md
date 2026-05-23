# ChatE MVP setup on Arch Linux

## Recommended route: use Python 3.13 or 3.12

Python 3.14 is still a rough target for several Python packages that compile Rust/C extensions. If dependency installation fails, use a project-specific Python 3.13/3.12 environment instead of forcing the app onto system Python.

```bash
sudo pacman -S --needed pyenv base-devel openssl zlib xz tk sqlite

# Add this to ~/.bashrc or ~/.zshrc if pyenv is not initialized already:
eval "$(pyenv init -)"

cd ~/Projects/chate_mvp/backend
pyenv install 3.13.5
pyenv local 3.13.5

rm -rf env .venv
python -m venv env
source env/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

## Python 3.14 route

This fixed requirements file uses Pydantic >= 2.12 because older Pydantic/pydantic-core builds can fail on Python 3.14.

```bash
cd ~/Projects/chate_mvp/backend
rm -rf env .venv
python -m venv env
source env/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

If Python 3.14 still fails on some other native dependency, stop wasting time and use Python 3.13/3.12 for this project.


## bcrypt/passlib note
This build intentionally does not use passlib[bcrypt]. On Python 3.14, passlib with newer bcrypt can crash during password hashing because bcrypt rejects passwords longer than 72 bytes during passlib's internal backend test. The MVP now uses stdlib PBKDF2-HMAC-SHA256 to avoid that dependency failure.

## Temporary public link for testing

Install Cloudflare Tunnel client:

```bash
sudo pacman -S --needed cloudflared
```

Start ChatE and generate a public HTTPS link:

```bash
cd ~/Projects/chate_mvp_fixed_v7/backend
source env/bin/activate
python share.py
```

You can also run this from the project root:

```bash
./scripts/share_cloudflare.sh
```

Copy the `https://*.trycloudflare.com` URL from the terminal. Anyone with that link can access the local dev server while the tunnel is running.
