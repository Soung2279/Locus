
import { describe, expect, it } from "vitest";
import {
  filterUnityObjectReferenceSearchResults,
  getUnityObjectReferenceTypeRule,
  isUnityObjectReferenceSearchResult,
  unityObjectReferenceDisplayParts,
  unityObjectReferenceValueForSearchResult,
  unityObjectReferenceSearchQuery,
  UNITY_OBJECT_REFERENCE_SEARCH_ROOTS,
} from "../services/unityObjectReferencePicker";
import type { AssetSearchResult } from "../types";

function asset(path: string, kind: string, typeLabel = "", overrides: Partial<AssetSearchResult> = {}): AssetSearchResult {
  const name = overrides.name ?? path.split("/").pop() ?? path;
  return {
    path,
    name,
    kind,
    typeLabel,
    isSubAsset: false,
    root: path.startsWith("Packages/") ? "packages" : "assets",
    matchScore: 10,
    source: "assetDb",
    ...overrides,
  };
}

describe("unityObjectReferencePicker", () => {
  it("builds AssetDatabase queries from reference types", () => {
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixerGroup",
    })).toBe("t:audiomixergroup");
    expect(unityObjectReferenceSearchQuery("Default", {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixerGroup",
    })).toBe("t:audiomixergroup Default");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixerSnapshot",
    })).toBe("t:audiomixersnapshot");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixer",
    })).toBe("mixer");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.RuntimeAnimatorController",
    })).toBe("t:controller");
    expect(unityObjectReferenceSearchQuery("Plan", {
      referenceTypeFullName: "UnityEngine.RuntimeAnimatorController",
    })).toBe("t:controller Plan");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Video.VideoClip",
    })).toBe("t:otherYaml");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.RenderTexture",
    })).toBe("t:rendertexture");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.PhysicMaterial",
    })).toBe("t:PhysicsMaterial");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.PhysicsMaterial",
    })).toBe("t:PhysicsMaterial");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.PhysicsMaterial2D",
    })).toBe("t:PhysicsMaterial2D");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.AudioResource",
    })).toBe("t:AudioResource");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Camera",
    })).toBe("t:prefab");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.ParticleSystem",
    })).toBe("t:prefab");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.ParticleSystemForceField",
    })).toBe("t:prefab");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.UIElements.VisualTreeAsset",
    })).toBe("t:visualtreeasset");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.UIElements.ThemeStyleSheet",
    })).toBe("t:themestylesheet");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.UIElements.PanelSettings",
    })).toBe("t:PanelSettings");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.TextCore.Text.FontAsset",
    })).toBe("t:FontAsset");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "",
    })).toBe("t:scene|prefab|material|animation|controller|genericAsset|script|texture|audio|shader|model|otherYaml");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEditor.MonoScript",
    })).toBe("t:script");
    expect(unityObjectReferenceSearchQuery("Player", {
      referenceTypeFullName: "Game.PlayerComponent",
    })).toBe("t:prefab component:PlayerComponent Player");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "UnityEngine.Component",
    })).toBe("t:prefab");
    expect(unityObjectReferenceSearchQuery("", {
      referenceTypeFullName: "Game.NPCMovementEventChannelSO",
    })).toBe("t:NPCMovementEventChannelSO");
    expect(unityObjectReferenceSearchQuery("Slime", {
      referenceTypeFullName: "Game.NPCMovementEventChannelSO",
    })).toBe("t:NPCMovementEventChannelSO Slime");
  });

  it("filters common Unity asset reference targets by type", () => {
    const results = [
      asset("Assets/Audio/Main.wav", "audio"),
      asset("Assets/Audio/Main.asset", "genericAsset", "AudioCueSO"),
      asset("Assets/Audio/Random.asset", "genericAsset", "AudioRandomContainer", {
        typeSearch: "audiorandomcontainer audioresource scriptableobject",
      }),
      asset("Assets/Settings/Audio/DefaultAudioMixer.mixer", "otherYaml"),
      asset("Assets/Settings/Audio/DefaultAudioMixer.mixer", "otherYaml", "AudioMixerGroupController", {
        name: "Music",
        isSubAsset: true,
        fileId: -2919845427630868010,
        objectKey: "mixer:music",
      }),
      asset("Assets/Settings/Audio/DefaultAudioMixer.mixer", "otherYaml", "AudioMixerSnapshotController", {
        name: "Snapshot",
        isSubAsset: true,
        fileId: -3791635409326915812,
        objectKey: "mixer:snapshot",
      }),
      asset("Assets/Prefabs/Player.prefab", "prefab"),
      asset("Assets/Scripts/Player.cs", "script"),
    ];

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.AudioClip",
    }).map((result) => result.path)).toEqual(["Assets/Audio/Main.wav"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.AudioResource",
    }).map((result) => result.path)).toEqual([
      "Assets/Audio/Main.wav",
      "Assets/Audio/Random.asset",
    ]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixerGroup",
    }).map(unityObjectReferenceValueForSearchResult)).toEqual(["Assets/Settings/Audio/DefaultAudioMixer.mixer/Music"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixerSnapshot",
    }).map(unityObjectReferenceValueForSearchResult)).toEqual(["Assets/Settings/Audio/DefaultAudioMixer.mixer/Snapshot"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.Audio.AudioMixer",
    }).map((result) => result.path)).toEqual(["Assets/Settings/Audio/DefaultAudioMixer.mixer"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEditor.MonoScript",
    }).map((result) => result.path)).toEqual(["Assets/Scripts/Player.cs"]);
  });

  it("keeps animator controller references constrained to controller assets", () => {
    const results = [
      asset("Assets/Art/Characters/PlantCritter/Animation/PlantCritter.controller", "animatorController"),
      asset("Assets/Art/Characters/PlantCritter/Animation/PlantCritterOverride.overrideController", "animatorController"),
      asset("Assets/Art/Characters/PlantCritter/Animation/PlantCritter.fbx", "model"),
      asset("Assets/Art/Characters/PlantCritter/Animation/PlantCritter_Attack.fbx", "model", "AnimationClip", {
        name: "PlantCritter_Attack",
        isSubAsset: true,
      }),
    ];

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.RuntimeAnimatorController",
    }).map((result) => result.path)).toEqual([
      "Assets/Art/Characters/PlantCritter/Animation/PlantCritter.controller",
      "Assets/Art/Characters/PlantCritter/Animation/PlantCritterOverride.overrideController",
    ]);
  });

  it("keeps common built-in asset references constrained by asset type", () => {
    const results = [
      asset("Assets/Video/Intro.mp4", "otherYaml"),
      asset("Assets/Video/Intro.mat", "material"),
      asset("Assets/Render/Main.renderTexture", "otherYaml"),
      asset("Assets/Render/Main.png", "texture"),
      asset("Assets/Physics/Bouncy.physicMaterial", "otherYaml"),
      asset("Assets/Physics/Ice.physicsMaterial", "otherYaml"),
      asset("Assets/Physics/Rubber.physicsMaterial2D", "otherYaml"),
      asset("Assets/Physics/Bouncy.mat", "material"),
      asset("Assets/UI/Hud.uxml", "otherYaml"),
      asset("Assets/UI/Hud.uss", "otherYaml"),
      asset("Assets/UI/DefaultTheme.tss", "otherYaml"),
      asset("Assets/UI/PanelSettings.asset", "genericAsset", "PanelSettings", {
        typeSearch: "panelsettings scriptableobject",
      }),
      asset("Assets/Fonts/MainFont.asset", "genericAsset", "FontAsset", {
        typeSearch: "fontasset textasset scriptableobject",
      }),
      asset("Assets/Data/GameConfig.asset", "genericAsset", "GameConfigSO", {
        typeSearch: "gameconfigso scriptableobject",
      }),
    ];

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.Video.VideoClip",
    }).map((result) => result.path)).toEqual(["Assets/Video/Intro.mp4"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.RenderTexture",
    }).map((result) => result.path)).toEqual(["Assets/Render/Main.renderTexture"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.PhysicMaterial",
    }).map((result) => result.path)).toEqual([
      "Assets/Physics/Bouncy.physicMaterial",
      "Assets/Physics/Ice.physicsMaterial",
    ]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.PhysicsMaterial",
    }).map((result) => result.path)).toEqual([
      "Assets/Physics/Bouncy.physicMaterial",
      "Assets/Physics/Ice.physicsMaterial",
    ]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.PhysicsMaterial2D",
    }).map((result) => result.path)).toEqual(["Assets/Physics/Rubber.physicsMaterial2D"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.UIElements.VisualTreeAsset",
    }).map((result) => result.path)).toEqual(["Assets/UI/Hud.uxml"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.UIElements.ThemeStyleSheet",
    }).map((result) => result.path)).toEqual([
      "Assets/UI/DefaultTheme.tss",
      "Assets/UI/PanelSettings.asset",
      "Assets/Fonts/MainFont.asset",
      "Assets/Data/GameConfig.asset",
    ]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.UIElements.PanelSettings",
    }).map((result) => result.path)).toEqual(["Assets/UI/PanelSettings.asset"]);

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "UnityEngine.TextCore.Text.FontAsset",
    }).map((result) => result.path)).toEqual(["Assets/Fonts/MainFont.asset"]);
  });

  it("keeps importer subassets by object type and formats user-facing references", () => {
    const sprite = asset("Assets/UI/Atlas.png", "texture", "Sprite", {
      name: "PrimaryButton",
      isSubAsset: true,
      fileId: 21300000,
      objectKey: "atlas:21300000",
    });
    const texture = asset("Assets/UI/Atlas.png", "texture");
    const mesh = asset("Assets/Models/Enemy.fbx", "model", "Mesh", {
      name: "EnemyBody",
      isSubAsset: true,
    });
    const clip = asset("Assets/Models/Enemy.fbx", "model", "AnimationClip", {
      name: "Attack",
      isSubAsset: true,
    });

    expect(filterUnityObjectReferenceSearchResults([texture, sprite], {
      referenceTypeFullName: "UnityEngine.Sprite",
    })).toEqual([sprite]);
    expect(filterUnityObjectReferenceSearchResults([mesh, clip], {
      referenceTypeFullName: "UnityEngine.Mesh",
    })).toEqual([mesh]);
    expect(filterUnityObjectReferenceSearchResults([mesh, clip], {
      referenceTypeFullName: "UnityEngine.AnimationClip",
    })).toEqual([clip]);
    expect(unityObjectReferenceValueForSearchResult(sprite)).toBe("Assets/UI/Atlas.png/PrimaryButton");
  });

  it("formats object reference display with the object name before its path", () => {
    expect(unityObjectReferenceDisplayParts("Assets/Data/GameConfig.asset")).toEqual({
      name: "GameConfig.asset",
      path: "Assets/Data",
    });
    expect(unityObjectReferenceDisplayParts("Assets/UI/Atlas.png/PrimaryButton")).toEqual({
      name: "PrimaryButton",
      path: "Assets/UI/Atlas.png",
    });
    expect(unityObjectReferenceDisplayParts("Assets/Data/Channels/")).toEqual({
      name: "Channels",
      path: "Assets/Data",
    });
    expect(unityObjectReferenceDisplayParts("Main Camera")).toEqual({
      name: "Main Camera",
      path: "",
    });
  });

  it("keeps scriptable object subclasses constrained to matching generic assets", () => {
    const results = [
      asset("Assets/Data/BasicAttack.asset", "genericAsset", "AttackConfigSO"),
      asset("Assets/Data/Music.asset", "genericAsset", "AudioCueSO"),
      asset("Assets/Prefabs/BasicAttack.prefab", "prefab"),
    ];

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "Game.AttackConfigSO",
    }).map((result) => result.path)).toEqual(["Assets/Data/BasicAttack.asset"]);
  });

  it("keeps scriptable object subclasses matched by indexed base type terms", () => {
    const results = [
      asset("Assets/Data/SlimeMove.asset", "genericAsset", "SlimeMoveChannel", {
        typeSearch: "slimemovechannel baseeventchannelso scriptableobject",
      }),
      asset("Assets/Data/Music.asset", "genericAsset", "AudioCueSO", {
        typeSearch: "audiocueso scriptableobject",
      }),
    ];

    expect(filterUnityObjectReferenceSearchResults(results, {
      referenceTypeFullName: "Game.BaseEventChannelSO",
    }).map((result) => result.path)).toEqual(["Assets/Data/SlimeMove.asset"]);
  });

  it("keeps broad UnityEngine.Object references open", () => {
    const prefab = asset("Assets/Prefabs/Player.prefab", "prefab");
    const material = asset("Assets/Materials/Player.mat", "material");

    expect(isUnityObjectReferenceSearchResult(prefab, {
      referenceTypeFullName: "UnityEngine.Object",
    })).toBe(true);
    expect(isUnityObjectReferenceSearchResult(material, {
      referenceTypeFullName: "UnityEngine.Object",
    })).toBe(true);
    expect(getUnityObjectReferenceTypeRule("").broad).toBe(true);
    expect([...UNITY_OBJECT_REFERENCE_SEARCH_ROOTS]).toEqual(["Assets", "Packages", "ProjectSettings"]);
  });
});
