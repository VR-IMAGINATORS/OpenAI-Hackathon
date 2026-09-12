import json
import re
import unittest
from pathlib import Path


MASTERS_PATH = Path(__file__).resolve().parents[1] / "assets" / "masters.json"
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")


def load_masters():
    return json.loads(MASTERS_PATH.read_text(encoding="utf-8"))


def assert_string_list(value):
    assert isinstance(value, list) and value
    assert all(isinstance(entry, str) and entry.strip() for entry in value)


def test_master_contract_has_expected_top_level_collections():
    masters = load_masters()
    assert set(masters) == {"version", "scenes", "gimmicks", "items"}
    assert masters["version"] == 1
    assert len(masters["scenes"]) == 6
    assert len(masters["gimmicks"]) == 10
    assert len(masters["items"]) == 10


def test_ids_are_unique_and_references_resolve():
    masters = load_masters()
    for collection in ("scenes", "gimmicks", "items"):
        ids = [entry["id"] for entry in masters[collection]]
        assert len(ids) == len(set(ids))
        assert all(ID_PATTERN.fullmatch(entry_id) for entry_id in ids)

    gimmick_ids = {gimmick["id"] for gimmick in masters["gimmicks"]}
    for scene in masters["scenes"]:
        for sequence in scene["sequences"]:
            assert set(sequence) <= gimmick_ids


def test_scenes_offer_multiple_three_obstacle_sequences():
    masters = load_masters()
    required = {"id", "name", "description", "anchor", "mystery", "sequences"}
    expected_scene_names = {
        "暗い倉庫", "コンクリート地下室", "廃病院", "使われていないボイラー室",
        "施錠された輸送コンテナ", "地下アーカイブ",
    }
    assert {scene["name"] for scene in masters["scenes"]} == expected_scene_names
    all_sequences = []
    for scene in masters["scenes"]:
        assert set(scene) == required
        assert all(isinstance(scene[key], str) and scene[key].strip() for key in required - {"sequences"})
        assert "中性的な成人" in scene["anchor"]
        assert "顔" in scene["anchor"]
        assert "炭色のフード付きジャケット" in scene["anchor"]
        assert "灰色のパンツ" in scene["anchor"]
        assert "使える道具" in scene["description"]
        assert "固定" in scene["description"]
        assert not any(token in scene["description"] for token in ("どの障害", "独立して", "一行動", "成立する"))
        assert len(scene["sequences"]) >= 2
        for sequence in scene["sequences"]:
            assert isinstance(sequence, list)
            assert len(sequence) == 3
            assert len(sequence) == len(set(sequence))
            all_sequences.append(tuple(sequence))
    assert len(all_sequences) == 18
    assert len(all_sequences) == len(set(all_sequences))


def test_gimmicks_have_three_hints_and_textual_solution_contracts():
    masters = load_masters()
    required = {
        "id", "name", "observation", "hints", "mechanism", "acceptance",
        "rejection", "examples", "reference_solutions",
    }
    restraint_names = {"布の目隠し", "椅子のロープ結び", "足首の封印具"}
    assert restraint_names <= {gimmick["name"] for gimmick in masters["gimmicks"]}
    for gimmick in masters["gimmicks"]:
        assert set(gimmick) == required
        assert isinstance(gimmick["observation"], str) and gimmick["observation"].strip()
        assert isinstance(gimmick["mechanism"], str) and gimmick["mechanism"].strip()
        assert_string_list(gimmick["hints"])
        assert len(gimmick["hints"]) == 3
        for field in ("acceptance", "rejection", "examples"):
            assert_string_list(gimmick[field])
        acceptance_text = " ".join(gimmick["acceptance"])
        assert "1行動" in acceptance_text
        assert re.search(r"写真[12]枚", acceptance_text)
        assert "限定せず" in " ".join(gimmick["examples"])


def test_reference_solutions_are_independent_and_solvable_in_three_actions():
    masters = load_masters()
    items = {item["id"]: item for item in masters["items"]}
    gimmicks = {gimmick["id"]: gimmick for gimmick in masters["gimmicks"]}
    solution_required = {
        "item_ids", "required_properties", "use", "photo_count", "preconditions",
        "consumes", "breaks", "clears", "postconditions",
    }

    for gimmick in masters["gimmicks"]:
        assert isinstance(gimmick["reference_solutions"], list) and gimmick["reference_solutions"]
        for solution in gimmick["reference_solutions"]:
            assert set(solution) == solution_required
            assert 1 <= solution["photo_count"] <= 2
            assert len(solution["item_ids"]) == solution["photo_count"]
            assert len(solution["item_ids"]) == len(set(solution["item_ids"]))
            assert all(item_id in items for item_id in solution["item_ids"])
            supplied_properties = {
                property_tag
                for item_id in solution["item_ids"]
                for property_tag in items[item_id]["properties"]
            }
            assert set(solution["required_properties"]) <= supplied_properties
            assert isinstance(solution["use"], str) and solution["use"].strip()
            assert solution["preconditions"] == []
            assert solution["consumes"] == []
            assert solution["breaks"] == []
            assert solution["clears"] is True
            assert_string_list(solution["postconditions"])

    for scene in masters["scenes"]:
        for sequence in scene["sequences"]:
            assert len(sequence) == 3
            chosen_solutions = [
                next(
                    solution
                    for solution in gimmicks[gimmick_id]["reference_solutions"]
                    if solution["clears"]
                    and not solution["preconditions"]
                    and 1 <= solution["photo_count"] <= 2
                )
                for gimmick_id in sequence
            ]
            action_count = len(chosen_solutions)
            assert action_count == 3
            assert action_count <= 4


def test_items_are_examples_not_whitelists():
    masters = load_masters()
    required = {"id", "name", "properties", "uses"}
    expected_item_names = {
        "はさみ", "カッター", "ヘアピン", "輪ゴム", "中身入りPETボトル",
        "懐中電灯", "タオル", "金属缶", "カード", "透明なガラス瓶",
    }
    assert {item["name"] for item in masters["items"]} == expected_item_names
    for item in masters["items"]:
        assert set(item) == required
        assert_string_list(item["properties"])
        assert_string_list(item["uses"])
        assert "例:" in " ".join(item["uses"])
        assert "限定せず" in " ".join(item["uses"])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(
        unittest.FunctionTestCase(function)
        for name, function in globals().items()
        if name.startswith("test_") and callable(function)
    )


if __name__ == "__main__":
    unittest.main()
