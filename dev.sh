set -a
source .env
python -m fastapi dev ./tile_server/app.py
