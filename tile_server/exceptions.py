class TileServerException(Exception):
    pass


class ErrorResponse(Exception):
    def __init__(self, code: int, status: str, message: str = ""):
        self.code = code
        self.status = status
        self.message = message
