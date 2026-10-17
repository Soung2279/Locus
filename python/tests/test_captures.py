import unittest
import locus

SCOPE = {"checkoutId": "capture-project", "expectedGeneration": 3}

class CaptureClient(locus.Client):
    def __init__(self):
        super().__init__(base_url="http://127.0.0.1/sdk", token="test", current_session_id="session-a")
        self.calls = []

    async def rpc(self, method, params=None, **kwargs):
        self.calls.append((method, params))
        if method == "captures.get": return {"id": params["captureId"], "spatial": True}
        return {"hit": False}

class CaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_handle_is_lazy_and_queries_keep_scope_and_fields(self):
        client = CaptureClient()
        capture = await client.captures.get("c42", workspace_ref=SCOPE)
        self.assertEqual([c[0] for c in client.calls], ["captures.get"])
        self.assertNotIn("matrix", repr(capture))
        result = await capture.pick(uv=(.25, .75), fields=["world"])
        self.assertEqual(result, {"hit": False})
        self.assertEqual(client.calls[-1], ("captures.pick", {
            "captureId": "c42", "sessionId": "session-a", "workspaceRef": SCOPE,
            "uv": [.25, .75], "fields": ["world"],
        }))
        await capture.objects(rect=(.1, .2, .3, .4), fields=["ref"], limit=8, offset=8)
        self.assertEqual(client.calls[-1][1]["offset"], 8)
        self.assertEqual(client.calls[-1][1]["fields"], ["ref"])

    async def test_invalid_coordinates_and_unbounded_queries_never_reach_rpc(self):
        client = CaptureClient()
        capture = await client.captures.get("c42", workspace_ref=SCOPE)
        client.calls.clear()
        for uv in [(-1, 0), (1.01, 0), (float("nan"), 0), (True, 0), (0, 0, 0)]:
            with self.assertRaises(ValueError): await capture.pick(uv=uv)
        for limit in [0, 33, True, 1.5]:
            with self.assertRaises(ValueError): await capture.objects(limit=limit)
        with self.assertRaises(ValueError): await capture.objects(rect=(.4, .2, .3, .4))
        with self.assertRaises(ValueError): await capture.pick(uv=(.5,.5), fields=["all_pixels"])
        self.assertEqual(client.calls, [])

    async def test_capture_access_requires_a_session(self):
        client = CaptureClient(); client.current_session_id = None
        with self.assertRaises(ValueError): await client.captures.get("c42", workspace_ref=SCOPE)
        self.assertEqual(client.calls, [])
