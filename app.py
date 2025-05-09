from flask import Flask, render_template, request, jsonify, session
from flask_socketio import SocketIO, emit, join_room as sio_join_room, leave_room as sio_leave_room
import uuid
import time
from copy import deepcopy
import numpy as np # For matrix operations
from pymcdm.methods import TOPSIS
# If you needed a specific normalization from pymcdm, you'd import it like:
# from pymcdm.normalizations import vector_normalization 

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_very_secret_key_here!' # Important for session and SocketIO
socketio = SocketIO(app, cors_allowed_origins="*") # Allow all origins for demo

# --- In-memory data storage (for demo purposes) ---
rooms_data = {}
# Example room structure:
# rooms_data['ROOM-XYZ'] = {
#     'id': 'ROOM-XYZ',
#     'name': 'Test Room',
#     'host_id': 'user_abc',
#     'host_name': 'Alice',
#     'members': [{'id': 'user_abc', 'name': 'Alice'}],
#     'private_items': {'user_abc': []}, # { user_id: [item_obj, ...] }
#     'public_items': [], # [item_obj_with_ratings, ...]
#     'users_done_rating': [], # [user_id, ...]
#     'final_decision_scoring': None,
#     'final_decision_topsis': None
# }

FAKE_DATA_ITEMS = [
    {'id': 'p1', 'name': 'Eiffel Tower', 'category': 'Landmark', 'type': 'place'},
    {'id': 'r1', 'name': 'Pizza Place Roma', 'category': 'Italian', 'type': 'restaurant'},
    {'id': 'a1', 'name': 'Cinema City - Action Movie', 'category': 'Entertainment', 'type': 'activity'},
    {'id': 'p2', 'name': 'Louvre Museum', 'category': 'Art', 'type': 'place'},
    {'id': 'r2', 'name': 'Sushi Samba', 'category': 'Japanese', 'type': 'restaurant'},
    {'id': 'a2', 'name': 'The Board Room Cafe', 'category': 'Games', 'type': 'activity'},
]

EMOTION_RATINGS_CONFIG = {
    'VERY_INTERESTED': {'emoji': '😍', 'score': 5, 'label': 'Very Interested'},
    'INTERESTED':      {'emoji': '🙂', 'score': 3, 'label': 'Interested'},
    'OKAY':            {'emoji': '😐', 'score': 1, 'label': 'Okay'}, 
    'NOT_INTERESTED':  {'emoji': '😕', 'score': -2, 'label': 'Not Interested'},
    'NOT_AT_ALL':      {'emoji': '😠', 'score': -5, 'label': 'Not Interested At All'}
}

# --- Helper Functions ---
def generate_unique_id(prefix=""):
    return f"{prefix}{uuid.uuid4().hex[:6].upper()}"

def get_room_or_abort(room_id):
    room = rooms_data.get(room_id)
    if not room:
        return None 
    return room

def broadcast_room_update(room_id):
    room = get_room_or_abort(room_id)
    if room:
        socketio.emit('room_state_updated', {'room': deepcopy(room)}, room=room_id)
        print(f"Broadcasted update for room {room_id}")

def reset_decisions_and_done_ratings(room):
    room['final_decision_scoring'] = None
    room['final_decision_topsis'] = None
    room['users_done_rating'] = []

# --- Decision Logic ---
def calculate_scoring_method_decision(room_state): # Takes a copy of room state
    if not room_state or not room_state.get('public_items'):
        return {"text": "No items for Scoring method.", "details": ""}

    decision_candidates = []
    for item_idx, item_data in enumerate(room_state['public_items']):
        sum_positive_scores = 0
        sum_negative_scores_abs = 0
        count_nia = 0
        count_vi = 0
        num_ratings = 0
        total_raw_score = 0
        item_ratings = item_data.get('ratings', {})

        for user_id, emotion_key in item_ratings.items():
            if emotion_key in EMOTION_RATINGS_CONFIG:
                score = EMOTION_RATINGS_CONFIG[emotion_key]['score']
                total_raw_score += score
                num_ratings += 1
                if score > EMOTION_RATINGS_CONFIG['OKAY']['score']:
                    sum_positive_scores += score
                if score < EMOTION_RATINGS_CONFIG['OKAY']['score']:
                    sum_negative_scores_abs += abs(score)
                if emotion_key == 'NOT_AT_ALL':
                    count_nia += 1
                if emotion_key == 'VERY_INTERESTED':
                    count_vi += 1
        
        decision_candidates.append({
            'name': item_data['name'],
            'unique_instance_id': item_data['unique_instance_id'],
            'sum_positive_scores': sum_positive_scores,
            'sum_negative_scores_abs': sum_negative_scores_abs,
            'count_nia': count_nia,
            'count_vi': count_vi,
            'num_ratings': num_ratings,
            'avg_score': total_raw_score / num_ratings if num_ratings > 0 else 0,
            'total_raw_score': total_raw_score
        })

    if not decision_candidates:
        return {"text": "No items were rated for Scoring method.", "details": ""}

    decision_candidates.sort(key=lambda x: (
        x['count_nia'], -x['count_vi'], -x['avg_score'], -x['total_raw_score']
    ))
    
    winner = decision_candidates[0]
    decision_text = f"🏆 Top (Scoring Method): {winner['name']}"
    decision_details = (
        f"Prioritizes minimizing strong dislikes, then maximizing high interest.<br>"
        f"Avg Score: {winner['avg_score']:.2f}, VI: {winner['count_vi']}, NIA: {winner['count_nia']}."
    )
    if winner['count_nia'] > 0:
        decision_details += "<br><b>Warning (Scoring):</b> This choice has strong objection(s)."
    return {"text": decision_text, "details": decision_details, "winner_id": winner['unique_instance_id']}

def calculate_topsis_decision(room_state): # Takes a copy of room state
    if not room_state or not room_state.get('public_items') or not room_state.get('members'):
        return {"text": "Not enough data for TOPSIS.", "details": ""}

    alternatives = room_state['public_items']
    if not alternatives: return {"text": "No items for TOPSIS.", "details": ""}
    
    num_alternatives = len(alternatives)
    num_criteria = len(room_state['members']) 
    if num_criteria == 0: return {"text": "No members in room for TOPSIS.", "details": ""}

    decision_matrix = np.full((num_alternatives, num_criteria), float(EMOTION_RATINGS_CONFIG['OKAY']['score']))
    member_id_to_idx = {member['id']: i for i, member in enumerate(room_state['members'])}

    for alt_idx, item_data in enumerate(alternatives):
        item_ratings = item_data.get('ratings', {})
        for user_id, emotion_key in item_ratings.items():
            if user_id in member_id_to_idx and emotion_key in EMOTION_RATINGS_CONFIG:
                crit_idx = member_id_to_idx[user_id]
                decision_matrix[alt_idx, crit_idx] = float(EMOTION_RATINGS_CONFIG[emotion_key]['score'])

    weights = np.full(num_criteria, 1.0 / num_criteria)
    types = np.ones(num_criteria) # All criteria are benefit (higher score is better)

    try:
        topsis = TOPSIS() # Uses default vector normalization
        pref = topsis(decision_matrix, weights, types) 
        ranking = topsis.rank(pref) 

        winner_idx_arr = np.where(ranking == 1)[0]
        if len(winner_idx_arr) == 0:
            return {"text": "TOPSIS Error: No winner found from ranking.", "details": "This can happen with unusual data."}
        winner_idx = winner_idx_arr[0]
        
        winner_item = alternatives[winner_idx]
        
        winner_ratings_obj = winner_item.get('ratings', {})
        winner_scores_values = [EMOTION_RATINGS_CONFIG[ek]['score'] for ek in winner_ratings_obj.values() if ek in EMOTION_RATINGS_CONFIG]
        avg_winner_score = np.mean(winner_scores_values) if winner_scores_values else EMOTION_RATINGS_CONFIG['OKAY']['score']
        count_nia_winner = sum(1 for emotion_key in winner_ratings_obj.values() if emotion_key == 'NOT_AT_ALL')

        decision_text = f"🏅 Top (TOPSIS Method): {winner_item['name']}"
        decision_details = (
            f"Selected as closest to the 'ideal group preference' and farthest from 'worst-case'.<br>"
            f"Avg Score (approx for winner): {avg_winner_score:.2f}, NIA count for winner: {count_nia_winner}."
        )
        if count_nia_winner > 0:
             decision_details += "<br><b>Note (TOPSIS):</b> This choice might still have strong objection(s), but was mathematically optimal given the ratings."

        return {"text": decision_text, "details": decision_details, "winner_id": winner_item['unique_instance_id']}

    except Exception as e:
        print(f"TOPSIS calculation error: {e}")
        details_str = str(e)
        # Check for common issues
        if decision_matrix.shape[0] > 0 and np.all(decision_matrix == decision_matrix[0,0]):
             details_str = "All ratings in the decision matrix are identical. TOPSIS cannot rank."
        elif np.any(np.all(decision_matrix == 0, axis=0)): # A user rated everything 0 (if OKAY was 0)
             details_str = "One or more users provided only neutral (zero value) ratings for all items. TOPSIS may struggle with this."
        
        return {"text": "TOPSIS calculation failed.", "details": f"Error: {details_str}"}

def calculate_final_decisions_for_room(room_id):
    room = get_room_or_abort(room_id)
    if not room: return

    if len(room.get('users_done_rating', [])) < len(room.get('members', [])):
        room['final_decision_scoring'] = None 
        room['final_decision_topsis'] = None
        return

    # Pass deep copies to prevent accidental modification of the main room state by calculation functions
    room['final_decision_scoring'] = calculate_scoring_method_decision(deepcopy(room))
    room['final_decision_topsis'] = calculate_topsis_decision(deepcopy(room))

# --- Flask Routes (API Endpoints) ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/create_room', methods=['POST'])
def create_room_api():
    data = request.json
    room_name = data.get('room_name'); user_name = data.get('user_name'); user_id = data.get('user_id') 
    if not all([room_name, user_name, user_id]): return jsonify({'error': 'Missing data'}), 400

    room_id = "ROOM-" + generate_unique_id()
    rooms_data[room_id] = {
        'id': room_id, 'name': room_name, 'host_id': user_id, 'host_name': user_name,
        'members': [{'id': user_id, 'name': user_name}],
        'private_items': {user_id: []}, 'public_items': [],
        'users_done_rating': [], 'final_decision_scoring': None, 'final_decision_topsis': None
    }
    print(f"Room created: {room_id} by {user_name}")
    return jsonify({'room': rooms_data[room_id]}), 201

@app.route('/api/join_room', methods=['POST'])
def join_room_api():
    data = request.json
    room_id = data.get('room_id'); user_name = data.get('user_name'); user_id = data.get('user_id')
    if not all([room_id, user_name, user_id]): return jsonify({'error': 'Missing data'}), 400

    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404

    if not any(m['id'] == user_id for m in room['members']):
        room['members'].append({'id': user_id, 'name': user_name})
        if user_id not in room['private_items']: room['private_items'][user_id] = []
    
    # Don't broadcast here, let SocketIO join handler send initial state to the joiner
    # broadcast_room_update(room_id) 
    print(f"User {user_name} joining room {room_id} (API)")
    return jsonify({'room': room}) # Return current room state to joiner

@app.route('/api/room/<room_id>/leave', methods=['POST'])
def leave_room_api(room_id):
    data = request.json; user_id = data.get('user_id')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404

    room['members'] = [m for m in room['members'] if m['id'] != user_id]
    if user_id in room['private_items']: del room['private_items'][user_id]
    if user_id in room.get('users_done_rating', []):
        room['users_done_rating'].remove(user_id)
        if len(room['users_done_rating']) < len(room['members']):
            room['final_decision_scoring'] = None; room['final_decision_topsis'] = None

    if not room['members']:
        del rooms_data[room_id]; print(f"Room {room_id} deleted.")
    elif room['host_id'] == user_id:
        room['host_id'] = None; room['host_name'] = None; print(f"Host left room {room_id}.")

    broadcast_room_update(room_id)
    return jsonify({'message': 'Left room successfully'})

@app.route('/api/room/<room_id>/item/private', methods=['POST'])
def add_private_item_api(room_id):
    data = request.json; user_id = data.get('user_id'); item_details = data.get('item') 
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404
    if user_id not in room['private_items']: room['private_items'][user_id] = []

    is_duplicate = any(
        (item_details.get('item_original_id') and ex.get('item_original_id') == item_details['item_original_id']) or
        (not item_details.get('item_original_id') and ex['name'].lower() == item_details['name'].lower())
        for ex in room['private_items'][user_id]
    )
    if not is_duplicate:
        new_item = {
            'unique_instance_id': 'priv_' + generate_unique_id(), 'name': item_details['name'],
            'category': item_details.get('category', 'Custom Idea'), 'type': item_details.get('type', 'User Input'),
            'item_original_id': item_details.get('item_original_id')
        }
        room['private_items'][user_id].append(new_item)
        broadcast_room_update(room_id)
        return jsonify({'message': 'Item added to private list', 'item': new_item}), 201
    return jsonify({'error': 'Item already in your private list'}), 409

@app.route('/api/room/<room_id>/item/private/delete', methods=['POST'])
def delete_private_item_api(room_id):
    data = request.json; user_id = data.get('user_id'); item_instance_id = data.get('item_instance_id')
    room = get_room_or_abort(room_id)
    if not room or user_id not in room['private_items']: return jsonify({'error': 'Not found or no private items'}), 404
    
    initial_len = len(room['private_items'][user_id])
    room['private_items'][user_id] = [i for i in room['private_items'][user_id] if i['unique_instance_id'] != item_instance_id]
    if len(room['private_items'][user_id]) < initial_len:
        broadcast_room_update(room_id)
        return jsonify({'message': 'Private item deleted'})
    return jsonify({'error': 'Private item not found'}), 404

@app.route('/api/room/<room_id>/item/send_to_public', methods=['POST'])
def send_to_public_api(room_id):
    data = request.json; user_id = data.get('user_id'); user_name = data.get('user_name')
    private_item_instance_id = data.get('private_item_instance_id')
    room = get_room_or_abort(room_id)
    if not room or user_id not in room['private_items']: return jsonify({'error': 'Not found or no private items'}), 404

    item_to_move = next((i for i in room['private_items'][user_id] if i['unique_instance_id'] == private_item_instance_id), None)
    if not item_to_move: return jsonify({'error': 'Private item not found'}), 404

    original_id_check = item_to_move.get('item_original_id') or item_to_move['unique_instance_id']
    if any(pub_item.get('item_original_id') == original_id_check for pub_item in room['public_items']):
        room['private_items'][user_id] = [i for i in room['private_items'][user_id] if i['unique_instance_id'] != private_item_instance_id]
        broadcast_room_update(room_id)
        return jsonify({'message': 'Item was already public, removed from your private list'})

    public_item = {
        'unique_instance_id': 'pub_' + generate_unique_id(), 'name': item_to_move['name'],
        'category': item_to_move['category'], 'type': item_to_move['type'],
        'item_original_id': original_id_check, 'submitted_by': user_name, 'ratings': {}
    }
    room['public_items'].append(public_item)
    room['private_items'][user_id] = [i for i in room['private_items'][user_id] if i['unique_instance_id'] != private_item_instance_id]
    reset_decisions_and_done_ratings(room)
    broadcast_room_update(room_id)
    return jsonify({'message': 'Item sent to public', 'item': public_item})

@app.route('/api/room/<room_id>/item/public/host_add', methods=['POST'])
def host_add_public_item_api(room_id):
    data = request.json; user_id = data.get('user_id'); user_name = data.get('user_name')
    item_details = data.get('item')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404
    if room['host_id'] != user_id: return jsonify({'error': 'Only host can perform this action'}), 403
    
    if any(p['name'].lower() == item_details['name'].lower() and p.get('category') == 'Host Added' for p in room['public_items']):
        return jsonify({'error': 'Host-added item with this name already exists'}), 409

    public_item = {
        'unique_instance_id': 'pub_host_' + generate_unique_id(), 'name': item_details['name'],
        'category': 'Host Added', 'type': 'User Input', 'item_original_id': None,
        'submitted_by': f"{user_name} (Host)", 'ratings': {}
    }
    room['public_items'].append(public_item)
    reset_decisions_and_done_ratings(room)
    broadcast_room_update(room_id)
    return jsonify({'message': 'Item added to public by host', 'item': public_item})

@app.route('/api/room/<room_id>/item/public/delete', methods=['POST'])
def delete_public_item_api(room_id):
    data = request.json; user_id = data.get('user_id'); item_instance_id = data.get('item_instance_id')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404

    item_to_delete = next((i for i in room['public_items'] if i['unique_instance_id'] == item_instance_id), None)
    if not item_to_delete: return jsonify({'error': 'Public item not found'}), 404

    is_host = room['host_id'] == user_id
    is_submitter = item_to_delete['submitted_by'].startswith(data.get('user_name', ''))
    can_delete = is_host or (is_submitter and not item_to_delete['submitted_by'].endswith("(Host)"))
    if not can_delete: return jsonify({'error': 'Unauthorized to delete this item'}), 403

    room['public_items'] = [i for i in room['public_items'] if i['unique_instance_id'] != item_instance_id]
    reset_decisions_and_done_ratings(room)
    broadcast_room_update(room_id)
    return jsonify({'message': 'Public item deleted'})

@app.route('/api/room/<room_id>/item/public/rate', methods=['POST'])
def rate_public_item_api(room_id):
    data = request.json; user_id = data.get('user_id')
    item_instance_id = data.get('item_instance_id'); emotion_key = data.get('emotion_key')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404
    if user_id in room.get('users_done_rating', []): return jsonify({'error': 'You have already finalized your ratings'}), 403
    if emotion_key not in EMOTION_RATINGS_CONFIG: return jsonify({'error': 'Invalid emotion key'}), 400

    item = next((i for i in room['public_items'] if i['unique_instance_id'] == item_instance_id), None)
    if not item: return jsonify({'error': 'Public item not found'}), 404
    
    if 'ratings' not in item: item['ratings'] = {}
    if item['ratings'].get(user_id) == emotion_key: del item['ratings'][user_id]
    else: item['ratings'][user_id] = emotion_key
            
    if len(room.get('users_done_rating', [])) < len(room.get('members', [])):
        room['final_decision_scoring'] = None; room['final_decision_topsis'] = None
        
    broadcast_room_update(room_id)
    return jsonify({'message': 'Item rated successfully'})

@app.route('/api/room/<room_id>/finalize_ratings', methods=['POST'])
def finalize_ratings_api(room_id):
    data = request.json; user_id = data.get('user_id')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404

    if 'users_done_rating' not in room: room['users_done_rating'] = []
    if user_id not in room['users_done_rating']: room['users_done_rating'].append(user_id)

    if len(room['users_done_rating']) == len(room['members']):
        calculate_final_decisions_for_room(room_id)
    
    broadcast_room_update(room_id)
    return jsonify({'message': 'Ratings finalized'})

@app.route('/api/room/<room_id>/restart_ratings', methods=['POST'])
def restart_ratings_api(room_id):
    data = request.json; user_id = data.get('user_id')
    room = get_room_or_abort(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404
    if room['host_id'] != user_id: return jsonify({'error': 'Only host can restart ratings'}), 403

    reset_decisions_and_done_ratings(room)
    # for item in room['public_items']: item['ratings'] = {} # Optional: clear all individual ratings
    broadcast_room_update(room_id)
    return jsonify({'message': 'Rating process restarted'})

# --- SocketIO Event Handlers ---
@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")
    # Add logic here to find which user/room this SID was associated with and trigger a leave if necessary
    # This is more complex and requires mapping SIDs to user_ids/room_ids upon connection/join.
    # For this demo, explicit leave is primary.

@socketio.on('join_sio_room')
def handle_join_sio_room(data):
    room_id = data.get('room_id'); user_id = data.get('user_id') 
    if room_id and user_id:
        sio_join_room(room_id) 
        print(f"Socket {request.sid} (user {user_id}) joined SocketIO room {room_id}")
        room = get_room_or_abort(room_id)
        if room: # Send full room state to the user who just joined this SIO room
             emit('room_state_updated', {'room': deepcopy(room)}) 
        # And broadcast a simpler update to others if member list actually changed via API
        # The API join_room should handle the member list update and broadcast.
        # This SIO join is more about subscribing the socket to broadcasts.

@socketio.on('leave_sio_room')
def handle_leave_sio_room(data):
    room_id = data.get('room_id'); user_id = data.get('user_id')
    if room_id:
        sio_leave_room(room_id)
        print(f"Socket {request.sid} (user {user_id}) left SocketIO room {room_id}")

if __name__ == '__main__':
    print("Starting Flask app with SocketIO for MCDM Decider (TOPSIS)...")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)