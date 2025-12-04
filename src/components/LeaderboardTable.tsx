'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  Button,
  Box,
  Tabs,
  Tab,
  Typography,
  Skeleton,
  Avatar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Divider,
  TextField,
  FormControl,
  Select,
  MenuItem,
  useMediaQuery,
  LinearProgress,
} from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import CloseIcon from '@mui/icons-material/Close';
import LaunchIcon from '@mui/icons-material/Launch';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { useState, useEffect, useRef } from 'react';
import { useToast } from './ToastProvider';
import { alpha, useTheme } from '@mui/material/styles';
import SearchIcon from '@mui/icons-material/Search';
import InputAdornment from '@mui/material/InputAdornment';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import FollowDetailModal from './FollowDetailModal';
import { useAccess } from './AccessProvider';
import { apiRequest } from '@/lib/apiClient';

interface MembershipPlan {
  id: string;
  name: string;
  description?: string;
  price: string;
  url: string;
  affiliateLink: string | null;
  isPremium: boolean;
}

interface FollowOffer {
  enabled: boolean;
  priceCents: number;
  numPlays: number;
  checkoutUrl: string | null;
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  alias: string;
  whopName?: string;
  whopDisplayName?: string;
  whopUsername?: string;
  whopAvatarUrl?: string;
  companyId: string;
  membershipPlans?: MembershipPlan[];
  followOffer?: FollowOffer | null;
  winRate: number;
  unitsPL: number;
  plFromAggregate: number;
  plays: number;
  wins?: number;
  losses?: number;
  currentStreak: number;
  longestStreak: number;
}

type SortField = 'rank' | 'alias' | 'winRate' | 'unitsPL' | 'plays' | 'winsLosses' | 'currentStreak' | 'longestStreak' | null;
type SortDirection = 'asc' | 'desc' | null;

export default function LeaderboardTable() {
  const toast = useToast();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isDark = theme.palette.mode === 'dark';
  const { userId, companyId } = useAccess();
  const [range, setRange] = useState<'all' | '30d' | '7d'>('all');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<LeaderboardEntry | null>(null);
  const [membershipModalOpen, setMembershipModalOpen] = useState(false);
  const [selectedFollowEntry, setSelectedFollowEntry] = useState<LeaderboardEntry | null>(null);
  const [followModalOpen, setFollowModalOpen] = useState(false);

  // pagination + search
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');

  // sorting
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  const controlBg = alpha(theme.palette.background.paper, isDark ? 0.55 : 0.95);
  const controlBorder = alpha(theme.palette.primary.main, isDark ? 0.45 : 0.25);
  const controlHoverBg = alpha(theme.palette.primary.main, 0.2);
  const paginationDisabledColor = alpha(theme.palette.text.primary, 0.4);
  const membershipCardBg = alpha(theme.palette.background.paper, isDark ? 0.8 : 0.96);
  const membershipBorder = `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.45 : 0.2)}`;
  const controlStyles = {
    '& .MuiOutlinedInput-root': {
      color: 'var(--app-text)',
      backgroundColor: controlBg,
      '& fieldset': { borderColor: controlBorder },
      '&:hover fieldset': { borderColor: theme.palette.primary.main },
      '&.Mui-focused fieldset': {
        borderColor: theme.palette.primary.main,
        boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.15)}`,
      },
    },
    '& .MuiInputBase-input::placeholder': {
      color: 'var(--text-muted)',
      opacity: 1,
    },
  };

  const handleViewMembership = (entry: LeaderboardEntry) => {
    setSelectedCompany(entry);
    setMembershipModalOpen(true);
  };

  const handleCloseModal = () => {
    setMembershipModalOpen(false);
    setSelectedCompany(null);
  };

  const handleViewFollow = async (entry: LeaderboardEntry) => {
    // Verify eligibility before showing modal
    if (!userId || !companyId) {
      toast.showError('You must be logged in to follow creators.');
      return;
    }

    try {
      // Call verification API
      const verifyResponse = await apiRequest(
        `/api/follow/verify?capperUserId=${encodeURIComponent(entry.userId)}`,
        {
          method: 'GET',
          userId,
          companyId,
        }
      );

      if (!verifyResponse.ok) {
        toast.showError('Failed to verify follow eligibility. Please try again.');
        return;
      }

      const verifyData = await verifyResponse.json() as {
        canFollow: boolean;
        reason?: string;
        message?: string;
        remainingPlays?: number;
      };

      if (!verifyData.canFollow) {
        // Show error message based on reason
        if (verifyData.message) {
          toast.showError(verifyData.message);
        } else {
          toast.showError('You cannot follow this creator.');
        }
        return;
      }

      // Verification passed - show modal
      setSelectedFollowEntry(entry);
      setFollowModalOpen(true);
    } catch (error) {
      console.error('Error verifying follow eligibility:', error);
      toast.showError('An error occurred while verifying follow eligibility.');
    }
  };

  const handleCloseFollowModal = () => {
    setFollowModalOpen(false);
    setSelectedFollowEntry(null);
  };

  // Removed unused copyAffiliateLink function

  const hasLoadedOnceRef = useRef(false);

  const fetchLeaderboard = async (preserveData = hasLoadedOnceRef.current) => {
    if (preserveData) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const params = new URLSearchParams({ range, page: String(page), pageSize: String(pageSize) });
      if (search.trim()) params.set('search', search.trim());
      if (sortField) {
        params.set('sortField', sortField);
        params.set('sortDirection', sortDirection || 'asc');
      }
      const response = await fetch(`/api/leaderboard?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');
      const data = await response.json();
      setLeaderboard(data.leaderboard || []);
      setTotalPages(data.totalPages || 1);
    } catch (error) {
      console.error('Error fetching leaderboard:', error);
    } finally {
      if (preserveData) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
      hasLoadedOnceRef.current = true;
    }
  };

  useEffect(() => {
    fetchLeaderboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, page, pageSize, sortField, sortDirection]);

  // Debounced search-as-you-type
  useEffect(() => {
    const handle = setTimeout(() => {
      setPage(1);
      fetchLeaderboard();
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const getPLColor = (pl: number) => (pl >= 0 ? 'success' : 'error');

  // Handle column header click for sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Toggle direction: asc -> desc -> null
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortField(null);
        setSortDirection(null);
      }
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setPage(1); // Reset to first page when sorting changes
  };

  // Render sort icon
  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return null;
    }
    return sortDirection === 'asc' ? (
      <ArrowUpwardIcon sx={{ fontSize: 16, ml: 0.5 }} />
    ) : (
      <ArrowDownwardIcon sx={{ fontSize: 16, ml: 0.5 }} />
    );
  };

  return (
    <Box>
      <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} mb={2} gap={2} flexWrap="wrap">
        <Tabs
          value={range}
          onChange={(_, v) => { setRange(v); setPage(1); }}
          variant="scrollable"
          scrollButtons="auto"
          sx={{
            width: { xs: '100%', sm: 'auto' },
            '& .MuiTab-root': {
              color: 'var(--text-muted)',
              fontWeight: 500,
              fontSize: { xs: '0.875rem', sm: '1rem' },
              minHeight: { xs: 40, sm: 48 },
              '&.Mui-selected': {
                color: 'var(--app-text)',
                fontWeight: 600,
              },
            },
            '& .MuiTabs-indicator': {
              backgroundColor: 'var(--app-text)',
            },
          }}
        >
          <Tab label="All" value="all" />
          <Tab label="30d" value="30d" />
          <Tab label="7d" value="7d" />
        </Tabs>
        <Box display="flex" gap={1} alignItems="center" flexWrap="wrap" width={{ xs: '100%', sm: 'auto' }}>
          <TextField
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); fetchLeaderboard(); } }}
            placeholder="Search Whops..."
            sx={{
              width: { xs: '100%', sm: 260 },
              ...controlStyles,
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'var(--text-muted)' }} />
                </InputAdornment>
              ),
            }}
          />
          <Box display="flex" alignItems="center" gap={1} ml={{ xs: 0, sm: 2 }}>
            <Typography variant="body2" sx={{ color: 'var(--app-text)', whiteSpace: 'nowrap', fontSize: { xs: '0.875rem', sm: '1rem' } }}>Page size</Typography>
            <FormControl size="small">
              <Select
                value={pageSize}
                onChange={(e) => { setPageSize(e.target.value as number); setPage(1); }}
                sx={{
                  minWidth: 70,
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                }}
              >
                {[10, 20, 50].map((s) => (
                  <MenuItem key={s} value={s} sx={{ color: 'var(--app-text)' }}>{s}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>
      </Box>

      {loading ? (
        <Box>
          {[...Array(5)].map((_, i) => (
            <Paper key={i} sx={{ p: 2, mb: 2, background: 'var(--surface-bg)', border: '1px solid var(--surface-border)' }}>
              <Box display="flex" alignItems="center" gap={2}>
                <Skeleton variant="circular" width={32} height={32} sx={{ bgcolor: 'rgba(45, 80, 61, 0.1)' }} />
                <Box flex={1}>
                  <Skeleton variant="text" width="40%" height={24} sx={{ bgcolor: 'rgba(45, 80, 61, 0.1)', mb: 1 }} />
                  <Skeleton variant="text" width="60%" height={20} sx={{ bgcolor: 'rgba(45, 80, 61, 0.05)' }} />
                </Box>
                <Box display="flex" gap={2}>
                  <Skeleton variant="rectangular" width={80} height={40} sx={{ borderRadius: 2, bgcolor: 'rgba(45, 80, 61, 0.1)' }} />
                  <Skeleton variant="rectangular" width={80} height={40} sx={{ borderRadius: 2, bgcolor: 'rgba(45, 80, 61, 0.1)' }} />
                </Box>
              </Box>
            </Paper>
          ))}
        </Box>
      ) : (
        <Box sx={{ position: 'relative' }}>
          {refreshing && (
            <LinearProgress
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 2,
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
              }}
            />
          )}
          <TableContainer
            component={Paper}
            sx={{
              background: 'var(--surface-bg)',
              border: '1px solid var(--surface-border)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
              overflowX: 'auto',
              opacity: refreshing ? 0.85 : 1,
              transition: 'opacity 0.2s ease',
            }}
          >
            <Table sx={{ minWidth: isMobile ? 800 : 650 }}>
              <TableHead>
                <TableRow>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('rank')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>Rank</strong>
                      {renderSortIcon('rank')}
                    </Box>
                  </TableCell>
                  <TableCell
                    onClick={() => handleSort('alias')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" gap={0.5}>
                      <strong>Whop</strong>
                      {renderSortIcon('alias')}
                    </Box>
                  </TableCell>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('winRate')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>Win %</strong>
                      {renderSortIcon('winRate')}
                    </Box>
                  </TableCell>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('unitsPL')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>P/L</strong>
                      {renderSortIcon('unitsPL')}
                    </Box>
                  </TableCell>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('winsLosses')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>W-L</strong>
                      {renderSortIcon('winsLosses')}
                    </Box>
                  </TableCell>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('currentStreak')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>Current Streak</strong>
                      {renderSortIcon('currentStreak')}
                    </Box>
                  </TableCell>
                  <TableCell
                    align="center"
                    onClick={() => handleSort('longestStreak')}
                    sx={{
                      color: 'var(--app-text)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.05),
                      },
                    }}
                  >
                    <Box display="flex" alignItems="center" justifyContent="center" gap={0.5}>
                      <strong>Longest Streak</strong>
                      {renderSortIcon('longestStreak')}
                    </Box>
                  </TableCell>
                  <TableCell align="center" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                    <strong>Membership</strong>
                  </TableCell>
                  <TableCell align="center" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                    <strong>Follow</strong>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {leaderboard.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ color: 'var(--app-text)' }}>
                      No entries found
                    </TableCell>
                  </TableRow>
                ) : (
                  leaderboard.map((entry) => {
                    const wins = entry.wins || 0;
                    const losses = entry.losses || 0;
                    const wlDisplay = wins > 0 || losses > 0 ? `${wins}-${losses}` : entry.plays.toString();

                    return (
                      <TableRow key={entry.userId} hover>
                        <TableCell align="center">
                          <Chip
                            label={`#${entry.rank}`}
                            color="primary"
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          <Box display="flex" alignItems="center" gap={1}>
                            <Avatar src={entry.whopAvatarUrl} sx={{ width: 32, height: 32 }}>
                              {(entry.alias || entry.whopDisplayName || '?').charAt(0).toUpperCase()}
                            </Avatar>
                            <Box>
                              <Typography variant="body2" sx={{ color: 'var(--app-text)', fontWeight: 500 }}>
                                {entry.alias || entry.whopDisplayName}
                              </Typography>
                              {entry.whopUsername && (
                                <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                                  @{entry.whopUsername}
                                </Typography>
                              )}
                            </Box>
                          </Box>
                        </TableCell>
                        <TableCell align="center">
                          <Chip
                            label={`${entry.winRate.toFixed(1)}%`}
                            color={entry.winRate >= 50 ? 'success' : 'default'}
                            size="small"
                          />
                        </TableCell>
                        <TableCell align="center">
                          <Chip
                            label={`${entry.unitsPL >= 0 ? '+' : ''}${entry.unitsPL.toFixed(2)} units`}
                            color={getPLColor(entry.unitsPL)}
                            size="small"
                          />
                        </TableCell>
                        <TableCell align="center" sx={{ color: 'var(--app-text)' }}>{wlDisplay}</TableCell>
                        <TableCell align="center">
                          {entry.currentStreak > 0 && (
                            <Chip
                              icon={<LocalFireDepartmentIcon />}
                              label={entry.currentStreak}
                              size="small"
                              color="warning"
                            />
                          )}
                          {entry.currentStreak === 0 && '-'}
                        </TableCell>
                        <TableCell align="center" sx={{ color: 'var(--app-text)' }}>{entry.longestStreak}</TableCell>
                        <TableCell align="center">
                          {entry.membershipPlans && entry.membershipPlans.length > 0 ? (
                            <Button
                              variant="contained"
                              size="small"
                              onClick={() => handleViewMembership(entry)}
                              sx={{
                                background: 'linear-gradient(135deg, #22c55e, #059669)',
                                color: 'white',
                                textTransform: 'none',
                                fontWeight: 600,
                                borderRadius: 9999,
                                px: 2.5,
                                '&:hover': {
                                  background: 'linear-gradient(135deg, #16a34a, #047857)',
                                },
                              }}
                            >
                              View Membership
                            </Button>
                          ) : (
                            <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                              No membership
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          {entry.followOffer?.enabled && (
                            <Button
                              variant="contained"
                              size="small"
                              onClick={() => handleViewFollow(entry)}
                              startIcon={<PersonAddAlt1Icon fontSize="small" />}
                              sx={{
                                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                                color: 'white',
                                textTransform: 'none',
                                fontWeight: 600,
                                borderRadius: 9999,
                                px: 2.5,
                                '&:hover': {
                                  background: 'linear-gradient(135deg, #16a34a, #15803d)',
                                },
                              }}
                            >
                              Follow
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <Box display="flex" justifyContent="center" py={2} gap={2} alignItems="center">
            <Button
              variant="outlined"
              disabled={page === 1}
              onClick={() => { setPage(p => Math.max(1, p - 1)); }}
              sx={{
                color: 'var(--app-text)',
                borderColor: controlBorder,
                backgroundColor: controlBg,
                '&:hover': {
                  borderColor: theme.palette.primary.main,
                  backgroundColor: controlHoverBg,
                },
                '&:disabled': {
                  borderColor: controlBorder,
                  color: paginationDisabledColor,
                },
              }}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', px: 2, color: 'text.secondary' }}>
              Page {page} / {totalPages}
            </Typography>
            <Button
              variant="outlined"
              disabled={page >= totalPages}
              onClick={() => { setPage(p => Math.min(totalPages, p + 1)); }}
              sx={{
                color: 'var(--app-text)',
                borderColor: controlBorder,
                backgroundColor: controlBg,
                '&:hover': {
                  borderColor: theme.palette.primary.main,
                  backgroundColor: controlHoverBg,
                },
                '&:disabled': {
                  borderColor: controlBorder,
                  color: paginationDisabledColor,
                },
              }}
            >
              Next
            </Button>
          </Box>
        </Box>
      )}

      {/* Membership Plans Modal */}
      <Dialog
        open={membershipModalOpen}
        onClose={handleCloseModal}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            background: theme.palette.background.paper,
            backdropFilter: 'blur(20px)',
            border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.3 : 0.2)}`,
            borderRadius: 3,
            boxShadow: theme.palette.mode === 'light'
              ? '0 12px 32px rgba(34, 197, 94, 0.08)'
              : '0 12px 32px rgba(0, 0, 0, 0.45)',
          },
        }}
      >
        <DialogTitle sx={{ color: 'var(--app-text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box display="flex" alignItems="center" gap={2}>
            {selectedCompany?.whopAvatarUrl && (
              <Avatar src={selectedCompany.whopAvatarUrl} sx={{ width: 40, height: 40 }}>
                {(selectedCompany.whopDisplayName || selectedCompany.alias || '?').charAt(0).toUpperCase()}
              </Avatar>
            )}
            <Box>
              <Typography variant="h6" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                {selectedCompany?.whopDisplayName || selectedCompany?.alias}
              </Typography>
              {selectedCompany?.whopUsername && (
                <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                  @{selectedCompany.whopUsername}
                </Typography>
              )}
              <Typography variant="caption" sx={{ color: 'var(--text-muted)', display: 'block', mt: 0.5 }}>
                Membership Plans
              </Typography>
            </Box>
          </Box>
          <IconButton
            onClick={handleCloseModal}
            sx={{ color: 'var(--text-muted)', '&:hover': { color: 'var(--app-text)' } }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <Divider sx={{ borderColor: alpha(theme.palette.divider, 0.5) }} />
        <DialogContent sx={{ mt: 2 }}>
          {selectedCompany?.membershipPlans && selectedCompany.membershipPlans.length > 0 ? (
            <Box display="flex" flexDirection="column" gap={3}>
              {selectedCompany.membershipPlans.map((plan) => (
                <Paper
                  key={plan.id}
                  sx={{
                    p: 3,
                    background: membershipCardBg,
                    border: membershipBorder,
                    borderRadius: 2,
                    transition: 'all 0.3s ease',
                    '&:hover': {
                      borderColor: alpha(theme.palette.primary.main, isDark ? 0.6 : 0.4),
                      boxShadow: theme.palette.mode === 'light'
                        ? '0 4px 20px rgba(34, 197, 94, 0.15)'
                        : '0 4px 20px rgba(0, 0, 0, 0.3)',
                    },
                  }}
                >
                  <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
                    <Box flex={1}>
                      <Box display="flex" alignItems="center" gap={1} mb={1}>
                        <Typography variant="h6" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                          {plan.name}
                        </Typography>
                        {plan.isPremium && (
                          <Chip
                            label="Premium"
                            size="small"
                            sx={{
                              background: alpha(theme.palette.primary.main, isDark ? 0.25 : 0.2),
                              color: theme.palette.primary.dark,
                              border: `1px solid ${alpha(theme.palette.primary.main, isDark ? 0.45 : 0.3)}`,
                            }}
                          />
                        )}
                      </Box>
                      {plan.description && (
                        <Typography variant="body2" sx={{ color: 'var(--text-muted)', mb: 1 }}>
                          {plan.description}
                        </Typography>
                      )}
                      <Typography variant="body2" sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
                        {plan.price}
                      </Typography>
                    </Box>
                  </Box>

                  {plan.affiliateLink && (
                    <Box mt={2} display="flex" gap={1}>
                      <Button
                        variant="contained"
                        fullWidth
                        onClick={() => window.open(plan.affiliateLink!, '_blank', 'noopener,noreferrer')}
                        startIcon={<LaunchIcon />}
                        sx={{
                          background: 'linear-gradient(135deg, #22c55e, #059669)',
                          color: 'white',
                          py: 1.5,
                          fontWeight: 600,
                          boxShadow: '0 4px 20px rgba(34, 197, 94, 0.3)',
                          '&:hover': {
                            background: 'linear-gradient(135deg, #16a34a, #047857)',
                            transform: 'translateY(-2px)',
                            boxShadow: '0 6px 30px rgba(34, 197, 94, 0.4)',
                          },
                          transition: 'all 0.3s ease',
                        }}
                      >
                        View Membership
                      </Button>
                    </Box>
                  )}
                </Paper>
              ))}
            </Box>
          ) : (
            <Box textAlign="center" py={4}>
              <Typography variant="body1" sx={{ color: 'var(--text-muted)' }}>
                No membership plans available
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
          <Button
            onClick={handleCloseModal}
            sx={{
              color: 'var(--app-text)',
              '&:hover': {
                background: alpha(theme.palette.text.primary, 0.05),
              },
            }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Follow Detail Modal */}
      <FollowDetailModal
        open={followModalOpen}
        onClose={handleCloseFollowModal}
        entry={selectedFollowEntry}
      />
    </Box>
  );
}

