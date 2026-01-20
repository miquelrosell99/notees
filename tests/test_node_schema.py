"""Tests to ensure Python and JavaScript schemas are in sync.

These tests catch integration issues like missing field mappings.

NOTE: These tests are currently skipped because the app.db.node_fields module
has not been implemented yet. The tests define expected behavior for when
this module is created.
"""
import sys
from pathlib import Path

import pytest

# Skip this entire module - the node_fields module doesn't exist yet
pytest.skip(
    "Skipping test_node_schema.py - app.db.node_fields module not implemented yet",
    allow_module_level=True
)

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db.node_fields import NODE_FIELD_SCHEMA, get_create_node_params, get_update_node_params


class TestNodeFieldExtraction:
    """Test that node field extraction works correctly."""
    
    def test_all_create_fields_extracted(self):
        """Ensure all is_* flags are extracted for create operations."""
        node_data = {
            'id': 'test-id',
            'content': 'Test content',
            'is_page': True,
            'is_tag': True,
            'is_property': True,
            'is_template': True,
            'is_task': True,
            'is_system': True,  # This field was missing before!
            'is_daily': True,
            'is_monthly': False,
            'is_yearly': False,
        }
        
        params = get_create_node_params(node_data)
        
        # All boolean flags should be present
        assert params['is_page'] == True
        assert params['is_tag'] == True
        assert params['is_property'] == True
        assert params['is_template'] == True
        assert params['is_task'] == True
        assert params['is_system'] == True
        assert params['is_daily'] == True
        assert params['is_monthly'] == False
        assert params['is_yearly'] == False
    
    def test_missing_fields_get_defaults(self):
        """Missing fields should get their default values."""
        node_data = {
            'content': 'Test',
        }
        
        params = get_create_node_params(node_data)
        
        # Booleans default to False
        assert params['is_system'] == False
        assert params['is_page'] == False
        
        # Lists default to empty
        assert params['tags'] == []
        
        # Dicts default to empty
        assert params['properties'] == {}
    
    def test_type_coercion(self):
        """Test that values are coerced to correct types."""
        node_data = {
            'is_page': 1,  # Should convert to True
            'is_system': 0,  # Should convert to False
            'order': '5',  # Should convert to 5
        }
        
        from app.db.node_fields import extract_node_fields
        params = extract_node_fields(node_data)
        
        assert params['is_page'] == True
        assert params['is_system'] == False


class TestSchemaCompleteness:
    """Test that our schema definition is complete."""
    
    def test_all_boolean_flags_present(self):
        """Ensure we haven't forgotten any is_* flags."""
        expected_flags = {
            'is_page', 'is_tag', 'is_property', 'is_template',
            'is_task', 'is_system', 'is_daily', 'is_monthly', 'is_yearly'
        }
        
        schema_flags = {k for k in NODE_FIELD_SCHEMA.keys() if k.startswith('is_')}
        
        assert schema_flags == expected_flags, \
            f"Missing flags: {expected_flags - schema_flags}, Extra flags: {schema_flags - expected_flags}"
    
    def test_create_params_include_all_flags(self):
        """The create_node params should include ALL boolean flags."""
        # Create test data with all flags set
        test_data: dict = {flag: True for flag in NODE_FIELD_SCHEMA.keys() if flag.startswith('is_')}
        test_data['content'] = 'test'
        
        params = get_create_node_params(test_data)
        
        # All flags should be present in params
        for flag in NODE_FIELD_SCHEMA.keys():
            if flag.startswith('is_'):
                assert flag in params, f"Flag {flag} missing from create params"


def test_upsert_node_sync():
    """Integration test: Simulates syncing a system node from JavaScript."""
    # This is the type of data that comes from the JavaScript client
    sync_data = {
        'id': '00000000-0000-0000-0000-000000000001',
        'uuid': '00000000-0000-0000-0000-000000000001',
        'name': 'page',
        'content': 'System tag for page nodes',
        'tags': ['00000000-0000-0000-0000-000000000005'],  # TAG system tag
        'is_system': True,  # This MUST be preserved!
        'is_tag': True,
        'created_at': '2026-01-15T10:00:00.000Z',
        'updated_at': '2026-01-15T10:00:00.000Z',
    }
    
    # Extract params as upsert_node does
    params = get_create_node_params(sync_data)
    
    # Critical assertion: is_system MUST be present and True
    assert 'is_system' in params, "is_system field missing - sync will lose this information!"
    assert params['is_system'] == True, "is_system value not preserved"
    
    # Also check other fields are present
    assert params['is_tag'] == True
    assert params['content'] == 'System tag for page nodes'


if __name__ == '__main__':
    # Run all tests
    print("Running Node Schema Tests...\n")
    
    # Test 1: Field Extraction
    print("Test 1: All create fields extracted")
    test = TestNodeFieldExtraction()
    try:
        test.test_all_create_fields_extracted()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    # Test 2: Default values
    print("Test 2: Missing fields get defaults")
    try:
        test.test_missing_fields_get_defaults()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    # Test 3: Type coercion
    print("Test 3: Type coercion")
    try:
        test.test_type_coercion()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    # Test 4: Schema completeness
    print("Test 4: All boolean flags present")
    test_schema = TestSchemaCompleteness()
    try:
        test_schema.test_all_boolean_flags_present()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    # Test 5: Create params include all flags
    print("Test 5: Create params include all flags")
    try:
        test_schema.test_create_params_include_all_flags()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    # Test 6: Upsert node sync
    print("Test 6: Upsert node sync simulation")
    try:
        test_upsert_node_sync()
        print("✅ PASSED\n")
    except AssertionError as e:
        print(f"❌ FAILED: {e}\n")
    
    print("All tests completed!")
