using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using UnityEditor;

namespace Locus
{
    public static partial class LocusBridge
    {
        // Optional Odin metadata crosses the existing attribute protocol. The bridge
        // has no Odin assembly dependency and never evaluates Odin expression strings.
        private static string PropertyListAttributeValue(Attribute attribute)
        {
            string name = attribute.GetType().FullName;
            if (name == "Sirenix.OdinInspector.FoldoutGroupAttribute")
                return Convert.ToString(ReadListMember(attribute, "GroupName"), CultureInfo.InvariantCulture) ?? "";
            if (name != "Sirenix.OdinInspector.ListDrawerSettingsAttribute") return "";
            var values = new Dictionary<string, object>();
            foreach (string member in new[] { "HideAddButton", "HideRemoveButton", "ShowFoldout", "ListElementLabelName", "AddCopiesLastElement", "AlwaysAddDefaultValue" })
                values[member] = ReadListMember(attribute, member);
            string[] members = { "ShowPaging", "DraggableItems", "NumberOfItemsPerPage", "IsReadOnly", "ShowItemCount", "ShowIndexLabels", "DefaultExpandedState" };
            string[] flags = { "PagingHasValue", "DraggableHasValue", "NumberOfItemsPerPageHasValue", "IsReadOnlyHasValue", "ShowItemCountHasValue", "ShowIndexLabelsHasValue", "DefaultExpandedStateHasValue" };
            for (int i = 0; i < members.Length; i++)
                if (Equals(ReadListMember(attribute, flags[i]), true)) values[members[i]] = ReadListMember(attribute, members[i]);
            return Locus.Json.LocusJson.SerializeData(values);
        }

        private static object ReadListMember(object owner, string name)
        {
            if (owner == null || string.IsNullOrEmpty(name) || name.StartsWith("@", StringComparison.Ordinal)) return null;
            for (Type type = owner.GetType(); type != null; type = type.BaseType)
            {
                const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
                FieldInfo field = type.GetField(name, flags);
                if (field != null) return field.GetValue(owner);
                PropertyInfo property = type.GetProperty(name, flags);
                if (property != null && property.GetIndexParameters().Length == 0 && property.GetGetMethod(true) != null)
                    return property.GetValue(owner, null);
            }
            return null;
        }

        private static object ResolveListMemberObject(SerializedProperty property, string path)
        {
            object current = property.serializedObject.targetObject;
            foreach (string part in path.Replace(".Array.data[", "[").Split('.'))
            {
                if (string.IsNullOrEmpty(part)) continue;
                int bracket = part.IndexOf('[');
                string member = bracket < 0 ? part : part.Substring(0, bracket);
                if (!string.IsNullOrEmpty(member)) current = ReadListMember(current, member);
                while (bracket >= 0 && current != null)
                {
                    int end = part.IndexOf(']', bracket);
                    int index;
                    IList list = current as IList;
                    if (end < 0 || list == null || !int.TryParse(part.Substring(bracket + 1, end - bracket - 1), out index) || index < 0 || index >= list.Count) return null;
                    current = list[index];
                    bracket = part.IndexOf('[', end);
                }
                if (current == null) return null;
            }
            return current;
        }

        private static readonly HashSet<Type> PropertyTreeDynamicPresentationTypes = new HashSet<Type>();

        private static void ApplyPropertyListPresentation(SerializedProperty property, SerializedPropertySnapshot snapshot, FieldInfo field)
        {
            if (field == null) return;
            var metadata = SerializedFieldMetadataFor(field);
            if (metadata.HasDynamicListPresentation && property.serializedObject.targetObject != null)
                PropertyTreeDynamicPresentationTypes.Add(property.serializedObject.targetObject.GetType());
            if (!snapshot.isArray && !metadata.HasDynamicListPresentation) return;
            try
            {
                var attributes = new List<SerializedPropertyAttributeInfo>(snapshot.attributes ?? new SerializedPropertyAttributeInfo[0]);
                if (snapshot.isArray)
                {
                    Type elementType = SerializedElementType(field.FieldType);
                    attributes.Add(new SerializedPropertyAttributeInfo {
                        type = "Locus.ListElementType", displayName = "ListElementType",
                        value = Locus.Json.LocusJson.SerializeData(new Dictionary<string, object> {
                            { "native", true }, { "fullName", FieldTypeFullName(elementType) },
                            { "assembly", FieldTypeAssembly(elementType) },
                            { "reference", elementType != null && typeof(UnityEngine.Object).IsAssignableFrom(elementType) }
                        })
                    });
                }
                object[] declarations = metadata.Declarations;
                string path = property.propertyPath;
                bool element = path.EndsWith("]", StringComparison.Ordinal) && path.LastIndexOf(".Array.data[", StringComparison.Ordinal) >= 0;
                if (element)
                {
                    object declaration = declarations.FirstOrDefault(value => value.GetType().FullName == "Sirenix.OdinInspector.ListDrawerSettingsAttribute");
                    string member = declaration != null ? ReadListMember(declaration, "ListElementLabelName") as string : null;
                    object value = string.IsNullOrEmpty(member) ? null : ReadListMember(ResolveListMemberObject(property, path), member);
                    if (value != null)
                        attributes.Add(new SerializedPropertyAttributeInfo { type = "Locus.ListElementLabel", displayName = "ListElementLabel", value = Convert.ToString(value, CultureInfo.InvariantCulture) });
                }
                else
                {
                    int dot = path.LastIndexOf('.');
                    object owner = ResolveListMemberObject(property, dot < 0 ? "" : path.Substring(0, dot));
                    bool visible = true;
                    foreach (object declaration in declarations)
                    {
                        string type = declaration.GetType().FullName;
                        if (type != "Sirenix.OdinInspector.ShowIfAttribute" && type != "Sirenix.OdinInspector.HideIfAttribute") continue;
                        string condition = ReadListMember(declaration, "Condition") as string;
                        object actual = ReadListMember(owner, condition);
                        object expected = ReadListMember(declaration, "Value");
                        // Unknown members/expressions remain visible rather than hiding editable data.
                        if (actual == null) continue;
                        bool matches = expected != null ? Equals(actual, expected) : actual is bool && (bool)actual;
                        visible &= type.EndsWith(".ShowIfAttribute", StringComparison.Ordinal) ? matches : !matches;
                    }
                    if (!visible) attributes.Add(new SerializedPropertyAttributeInfo { type = "Locus.PropertyVisibility", displayName = "PropertyVisibility", value = "false" });
                }
                snapshot.attributes = attributes.ToArray();
            }
            catch (Exception)
            {
                // Author getters may throw while assets are incomplete; raw property
                // editing must remain available even when presentation cannot resolve.
            }
        }

        private static bool PropertyRestoreContainsManagedReference(PropertyRestoreNode node)
        {
            return node.type == "ManagedReference" || (node.children ?? new PropertyRestoreNode[0]).Any(PropertyRestoreContainsManagedReference);
        }

        private static void DuplicateSerializedListElement(SerializedProperty property, int index)
        {
            if (index < 0 || index >= property.arraySize) throw new ArgumentOutOfRangeException("index");
            var source = CapturePropertyRestoreState(property.GetArrayElementAtIndex(index));
            if (PropertyRestoreContainsManagedReference(source))
                throw new InvalidOperationException("Managed reference elements require an explicit graph copy.");
            property.InsertArrayElementAtIndex(index + 1);
            RestorePropertyState(property.GetArrayElementAtIndex(index + 1), source, new Dictionary<long, object>(), new HashSet<long>());
        }

        private static void InsertInitializedListElement(SerializedProperty property, int index)
        {
            Type elementType = SerializedElementType(ResolveSerializedPropertyFieldType(property));
            if (elementType == null) throw new InvalidOperationException("List element type is unavailable.");
            object initial = elementType == typeof(string) ? ""
                : typeof(UnityEngine.Object).IsAssignableFrom(elementType) || elementType.IsAbstract || elementType.IsInterface ? null
                : elementType.IsArray ? Array.CreateInstance(elementType.GetElementType(), 0)
                : Activator.CreateInstance(elementType, true);
            property.InsertArrayElementAtIndex(index);
            var element = property.GetArrayElementAtIndex(index);
            if (element.propertyType == SerializedPropertyType.ManagedReference) element.managedReferenceValue = null;
            else if (element.isArray && element.propertyType == SerializedPropertyType.Generic) element.arraySize = 0;
            else element.boxedValue = initial;
        }

        private static void InsertListReferences(SerializedProperty property, int index, string[] paths)
        {
            Type elementType = SerializedElementType(ResolveSerializedPropertyFieldType(property));
            if (elementType == null || !typeof(UnityEngine.Object).IsAssignableFrom(elementType))
                throw new InvalidOperationException("This list does not accept object references.");
            if (paths == null || paths.Length == 0 || paths.Length > 1024) throw new ArgumentException("Invalid reference count.");
            // Resolve and validate the whole batch before changing the collection.
            var objects = paths.Select(path => {
                var value = LoadAssetAtPathForSerializedReference(path, elementType) ?? ResolveSubAssetReference(path, elementType);
                if (value == null || !IsSerializedObjectReferenceCompatible(value, elementType))
                    throw new InvalidOperationException("Object reference type does not match: " + path);
                return value;
            }).ToArray();
            for (int i = 0; i < objects.Length; i++) {
                property.InsertArrayElementAtIndex(index + i);
                property.GetArrayElementAtIndex(index + i).objectReferenceValue = objects[i];
            }
        }
    }
}
