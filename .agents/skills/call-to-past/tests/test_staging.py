from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("staging", Path(__file__).parents[1]/"scripts"/"staging.py")
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


def scene():
    def item(id, p, size):
        return {"id":id,"name":id,"description":id,"support":"fixed","solid":True,"size":size,
                "keys":[{"t":0,"position":p},{"t":15,"position":p}]}
    return {"version":1,"duration":15,"room":[4,3,6],"max_speed":1,"assumptions":["staging hypothesis"],
            "continuity":"same scene","outcome":"not escaped", "entities":[item("device",[3.8,1.5,1.8],[.1,.2,.2]),item("prop",[1,1,3],[.2,.2,.2])],
            "shots":[{"from":0,"to":11,"position":[1,1.5,.5],"target":[1,1.5,5],"fov":35,"action":"wait","sound":"wind"},
                     {"from":11,"to":15,"position":[1,1.5,.5],"target":[3.8,1.5,1.8],"fov":35,"action":"reveal","sound":"wind"}],
            "reveal":{"at":11,"entities":["device"]}}


class StagingTests(unittest.TestCase):
    def test_compile_is_reproducible_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td); source=path/"scene.json"
            source.write_text(json.dumps(scene()),encoding="utf8")
            a=staging.compile_plan(source,path/"a")
            b=staging.compile_plan(source,path/"b")
            self.assertEqual(a,b)
            self.assertEqual((path/"a/video-prompt.txt").read_bytes(),(path/"b/video-prompt.txt").read_bytes())
            with self.assertRaises(FileExistsError): staging.compile_plan(source,path/"a")

    def test_continuous_collision_detects_crossing_between_endpoints(self):
        p=scene(); prop=p["entities"][1]
        prop["keys"]=[{"t":0,"position":[3,1.5,1.8]},{"t":15,"position":[3.9,1.5,1.8]}]
        with self.assertRaisesRegex(ValueError,"collision"):
            staging.validate(p)

    def test_reveal_not_allowed_in_early_shot(self):
        p=scene(); p["shots"][0]["target"]=p["shots"][1]["target"]
        with self.assertRaisesRegex(ValueError,"early reveal"):
            staging.validate(p)

    def test_bounds_nan_speed_and_coverage(self):
        for mutate in (
            lambda p:p["entities"][1]["keys"][0].update(position=[0,1,3]),
            lambda p:p.update(duration=float("nan")),
            lambda p:p["entities"][1].update(keys=[{"t":0,"position":[1,1,3]},{"t":.01,"position":[2,1,3]},{"t":15,"position":[2,1,3]}]),
            lambda p:p["shots"][1].update(**{"from":12}),
        ):
            p=scene(); mutate(p)
            with self.assertRaises(ValueError): staging.validate(p)

    def test_camera_intersection(self):
        p=scene(); p["shots"][0]["position"]=[1,1,3]
        with self.assertRaisesRegex(ValueError,"camera intersects"):
            staging.validate(p)

    def test_prompt_reports_motion_and_no_speech(self):
        p=scene(); p["entities"][1]["keys"][-1]["position"]=[2,1,3]
        staging.validate(p)
        text=staging.prompt(p)
        self.assertIn("straight segment 1.00 m",text)
        self.assertIn("NO speech, dialogue, narration",text)
        self.assertIn("Explicit editorial hard cut",text)
        self.assertIn("Stays fixed",text)

    def test_html_escapes_script_closing_in_data(self):
        p=scene(); p["outcome"]="</script><script>alert(1)</script>"
        result=staging.preview(p)
        self.assertEqual(result.count("</script>"),1)
        self.assertIn("\\u003c/script>",result)


if __name__ == "__main__":
    unittest.main()
