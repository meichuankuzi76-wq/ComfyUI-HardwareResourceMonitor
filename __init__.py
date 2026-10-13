import asyncio
from aiohttp import web
from server import PromptServer
from .monitor import Monitor

WEB_DIRECTORY = './web'
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
monitor = Monitor()

@PromptServer.instance.routes.get('/hardware-resource-monitor/stats')
async def stats(request):
    return web.json_response(await asyncio.to_thread(monitor.sample))
